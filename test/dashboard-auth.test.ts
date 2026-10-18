import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { fresh, makeUser, axis } from './helpers.ts';
import { q, toVec } from '../src/db/index.ts';
import { config } from '../src/config.ts';
import { authApi, requireAdmin, sessionValue } from '../src/http/auth.ts';
import { createDashboardStatic } from '../src/http/static.ts';
import { app } from '../src/server.ts';

// Admin login (requireAdmin on /api/* as server.ts mounts it, plus the /auth router) and the static dashboard.
// /auth and the static router are mounted on a small app here so they're tested independently of server wiring.

const TOKEN = 'correct horse battery staple';
const DAY = 24 * 60 * 60_000;

const mini = new Hono();
mini.route('/auth', authApi);
mini.use('/api/*', requireAdmin);
mini.get('/api/ping', (c) => c.json({ ok: true }));
mini.post('/api/ping', (c) => c.json({ ok: true }));

// Each test gets its own client address so lockouts don't leak between tests.
let ipSeq = 0;
const newIp = () => `203.0.113.${++ipSeq}`;

const login = (token: unknown, ip = newIp(), headers: Record<string, string> = {}, url = '/auth/login') =>
  mini.request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, ...headers },
    body: JSON.stringify({ token }),
  });
const cookieOf = (res: Response) => (res.headers.get('set-cookie') ?? '').split(';')[0]!;
const session = (value: string) => `mixr_session=${value}`;

const saved = { adminToken: config.adminToken, production: config.production };
const useToken = (token = TOKEN) => {
  config.adminToken = token;
  config.production = true;
};

beforeAll(async () => {
  await fresh();
});

afterEach(() => {
  config.adminToken = saved.adminToken;
  config.production = saved.production;
  vi.useRealTimers();
});

describe('no ADMIN_TOKEN', () => {
  test('local dev (not production): the API is open and /auth reports it', async () => {
    config.adminToken = '';
    config.production = false;
    expect((await app.request('/api/state')).status).toBe(200);
    expect(await (await mini.request('/auth/me')).json()).toEqual({ authenticated: true, open: true });
    expect(await (await login('anything')).json()).toMatchObject({ ok: true, open: true });
  });

  test('production: everything is rejected with 503, credentials or not', async () => {
    config.adminToken = '';
    config.production = true;
    const res = await app.request('/api/state');
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('ADMIN_TOKEN not set');
    expect((await app.request('/api/state', { headers: { authorization: 'Bearer ' } })).status).toBe(503);
    expect((await login('anything')).status).toBe(503);
    expect((await mini.request('/auth/me')).status).toBe(503);
  });
});

describe('with ADMIN_TOKEN', () => {
  test('no credentials: 401', async () => {
    useToken();
    const res = await app.request('/api/state');
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/^Bearer/);
    expect(await (await mini.request('/auth/me')).json()).toEqual({ authenticated: false, open: false });
  });

  test('bearer token is accepted; a wrong one is rejected', async () => {
    useToken();
    const ip = newIp();
    expect((await app.request('/api/state', { headers: { authorization: `Bearer ${TOKEN}`, 'x-forwarded-for': ip } })).status).toBe(200);
    expect((await app.request('/api/state', { headers: { authorization: 'Bearer nope', 'x-forwarded-for': ip } })).status).toBe(401);
    expect((await app.request('/api/state', { headers: { authorization: `Basic ${TOKEN}`, 'x-forwarded-for': ip } })).status).toBe(401);
    // Bearer calls aren't cookie-based, so writes don't need the dashboard header.
    expect((await mini.request('/api/ping', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'x-forwarded-for': ip } })).status).toBe(200);
  });

  test('login sets a host-only, HttpOnly, SameSite=Lax 7-day session cookie that unlocks the API', async () => {
    useToken();
    const res = await login(TOKEN);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, authenticated: true, open: false });
    expect(res.headers.get('cache-control')).toBe('no-store');
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/^mixr_session=[\w-]+\.\d+;/);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toContain('Max-Age=604800');
    expect(setCookie).not.toMatch(/Domain=/i);
    expect(setCookie).not.toContain('Secure'); // plain http

    const cookie = cookieOf(res);
    expect((await app.request('/api/state', { headers: { cookie } })).status).toBe(200);
    expect(await (await mini.request('/auth/me', { headers: { cookie } })).json()).toEqual({ authenticated: true, open: false });

    // The live stream (EventSource) authenticates with the same cookie.
    const stream = await app.request('/api/stream', { headers: { cookie } });
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    await stream.body?.cancel();
    expect((await app.request('/api/stream')).status).toBe(401);
  });

  test('the cookie is Secure when the request came over https (proxy header or URL scheme)', async () => {
    useToken();
    expect((await login(TOKEN, newIp(), { 'x-forwarded-proto': 'https' })).headers.get('set-cookie')).toContain('Secure');
    expect((await login(TOKEN, newIp(), {}, 'https://any-host.example/auth/login')).headers.get('set-cookie')).toContain('Secure');
  });

  test('login failures: wrong token 401, missing token 400, no cookie either way', async () => {
    useToken();
    const wrong = await login('wrong');
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get('set-cookie')).toBeNull();
    expect((await login('')).status).toBe(400);
    expect((await login(42)).status).toBe(400);
    const notJson = await mini.request('/auth/login', { method: 'POST', body: 'token=x', headers: { 'x-forwarded-for': newIp() } });
    expect(notJson.status).toBe(400);
  });

  test('tampered, foreign, expired, future and garbage cookies are rejected', async () => {
    useToken();
    const now = Date.now();
    const good = sessionValue(TOKEN, now);
    const flipped = (good[0] === 'A' ? 'B' : 'A') + good.slice(1);
    const bad = [
      flipped,
      sessionValue('some other token', now),
      sessionValue(TOKEN, now - 8 * DAY),
      sessionValue(TOKEN, now + 10 * 60_000),
      `${good.split('.')[0]}.${now + 1}`, // valid MAC moved to another timestamp
      'garbage',
      '',
    ];
    expect((await app.request('/api/state', { headers: { cookie: session(good) } })).status).toBe(200);
    for (const value of bad) {
      expect((await app.request('/api/state', { headers: { cookie: session(value) } })).status, value).toBe(401);
      expect((await (await mini.request('/auth/me', { headers: { cookie: session(value) } })).json()).authenticated).toBe(false);
    }
    // Rotating ADMIN_TOKEN signs every session out.
    config.adminToken = 'rotated';
    expect((await app.request('/api/state', { headers: { cookie: session(good) } })).status).toBe(401);
  });

  test('cookie-authenticated writes need the dashboard header (a cross-site form cannot add it)', async () => {
    useToken();
    const cookie = cookieOf(await login(TOKEN));
    expect((await mini.request('/api/ping', { method: 'POST', headers: { cookie } })).status).toBe(403);
    expect((await mini.request('/api/ping', { method: 'POST', headers: { cookie, 'x-mixr-dashboard': '1' } })).status).toBe(200);
    expect((await mini.request('/api/ping', { headers: { cookie } })).status).toBe(200);
  });

  test('logout clears the cookie', async () => {
    useToken();
    const res = await mini.request('/auth/logout', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toMatch(/^mixr_session=;.*Max-Age=0/);
  });
});

describe('brute-force guard', () => {
  test('10 failures from one IP within 15 minutes lock that IP out, even with the right token, until they age out', async () => {
    useToken();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-17T12:00:00Z'));
    const ip = newIp();
    for (let i = 0; i < 10; i++) expect((await login('wrong', ip)).status).toBe(401);

    const locked = await login(TOKEN, ip);
    expect(locked.status).toBe(429);
    const retryAfter = Number(locked.headers.get('retry-after'));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(15 * 60);
    // Bearer from the locked IP is refused too; CF-Connecting-IP wins over X-Forwarded-For.
    expect((await mini.request('/api/ping', { headers: { authorization: `Bearer ${TOKEN}`, 'x-forwarded-for': ip } })).status).toBe(429);
    expect((await login(TOKEN, newIp(), { 'cf-connecting-ip': ip })).status).toBe(429);
    // Other addresses are unaffected.
    expect((await login(TOKEN, newIp())).status).toBe(200);

    vi.setSystemTime(new Date('2026-10-17T12:15:01Z'));
    expect((await login(TOKEN, ip)).status).toBe(200);
  });

  test('wrong bearer tokens count toward the same lockout', async () => {
    useToken();
    const ip = newIp();
    for (let i = 0; i < 10; i++) {
      expect((await mini.request('/api/ping', { headers: { authorization: 'Bearer guess', 'x-forwarded-for': ip } })).status).toBe(401);
    }
    expect((await login(TOKEN, ip)).status).toBe(429);
  });

  test('a successful login clears earlier failures', async () => {
    useToken();
    const ip = newIp();
    for (let i = 0; i < 9; i++) await login('wrong', ip);
    expect((await login(TOKEN, ip)).status).toBe(200);
    for (let i = 0; i < 9; i++) expect((await login('wrong', ip)).status).toBe(401);
    expect((await login(TOKEN, ip)).status).toBe(200);
  });
});

describe('dashboard API: pools', () => {
  test('a conversation says who typed each inbound text and what happened to each reply; events carry their pool', async () => {
    const [real] = await q<{ id: number }>(
      `INSERT INTO users (phone, name, state, seeded, joined_via) VALUES ('+12065557777', 'Rae', 'active', false, 'web') RETURNING id`,
    );
    const uid = real!.id;
    const msg = async (direction: string, text: string, via: string) =>
      (await q<{ id: number }>(`INSERT INTO messages (user_id, direction, text, sim_time, via) VALUES ($1, $2, $3, now(), $4) RETURNING id`, [uid, direction, text, via]))[0]!.id;
    const job = (messageId: number, status: string, error: string | null = null) =>
      q(`INSERT INTO message_jobs (user_id, message_id, dedupe_key, text, status, error) VALUES ($1, $2, $3, 'x', $4, $5)`, [uid, messageId, `t:${messageId}`, status, error]);
    await msg('in', 'from my phone', 'phone');
    await job(await msg('out', 'delivered', 'system'), 'sent');
    await msg('in', 'typed by the operator', 'dashboard');
    await msg('out', 'quiet reply', 'system'); // acting as them: nothing queued
    await job(await msg('out', 'went wrong', 'system'), 'failed', 'provider timeout');

    const res = await app.request('/api/messages/' + encodeURIComponent('+12065557777'));
    const msgs = await res.json();
    expect(msgs.map((m: any) => [m.direction, m.via, m.delivery])).toEqual([
      ['in', 'phone', undefined],
      ['out', 'system', 'sent'],
      ['in', 'dashboard', undefined],
      ['out', 'system', 'not_delivered'],
      ['out', 'system', 'failed'],
    ]);
    expect(msgs[4].deliveryError).toBe('provider timeout');
    expect(await (await app.request('/api/messages/%2B10000000000')).json()).toEqual([]);

    const demoHost = await makeUser('Dee', 'chess');
    for (const host of [uid, demoHost]) {
      await q(
        `INSERT INTO events (host_id, title, raw_description, starts_at, location, capacity, hyde_profile, initial_embedding, current_embedding, created_at)
         VALUES ($1, 'Chess', 'chess', now(), 'HUB', 4, 'Target Attendee', $2, $2, now())`,
        [host, toVec(axis(0))],
      );
    }
    const state = await (await app.request('/api/state')).json();
    expect(state.users.find((u: any) => u.id === uid)).toMatchObject({ pool: 'real', joinedVia: 'web' });
    expect(Object.fromEntries(state.events.map((e: any) => [e.hostId, e.pool]))).toEqual({ [uid]: 'real', [demoHost]: 'demo' });
  });
});

describe('static dashboard', () => {
  const base = mkdtempSync(join(tmpdir(), 'mixr-static-'));
  const root = join(base, 'dist');
  const INDEX = '<!doctype html><div id="root"></div>';
  mkdirSync(join(root, 'assets'), { recursive: true });
  writeFileSync(join(base, 'secret.txt'), 'secret');
  writeFileSync(join(root, 'index.html'), INDEX);
  writeFileSync(join(root, 'assets', 'index-abc123.js'), 'console.log("hi")');
  writeFileSync(join(root, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const site = createDashboardStatic(root);
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  test('/ and /dashboard redirect to /dashboard/ with a path-only Location (any hostname)', async () => {
    for (const path of ['/', '/dashboard']) {
      const res = await site.request(`https://whatever.example${path}`);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/dashboard/');
    }
  });

  test('index and client-side paths serve the SPA page, revalidated every time', async () => {
    for (const path of ['/dashboard/', '/dashboard/events/3', '/dashboard/index.html']) {
      const res = await site.request(path);
      expect(res.status, path).toBe(200);
      expect(await res.text()).toBe(INDEX);
      expect(res.headers.get('cache-control')).toBe('no-cache');
      expect(res.headers.get('content-type')).toContain('text/html');
    }
    expect((await site.request('/dashboard/')).headers.get('x-frame-options')).toBe('DENY');
  });

  test('hashed assets are cached for a year; a missing asset is a 404, not the page', async () => {
    const js = await site.request('/dashboard/assets/index-abc123.js');
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toContain('javascript');
    expect(js.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(await js.text()).toBe('console.log("hi")');
    expect((await site.request('/dashboard/assets/index-abc123.js', { method: 'HEAD' })).status).toBe(200);

    const missing = await site.request('/dashboard/assets/gone.js');
    expect(missing.status).toBe(404);
    expect(missing.headers.get('cache-control')).toBe('no-store');

    const icon = await site.request('/dashboard/favicon.svg');
    expect(icon.status).toBe(200);
    expect(icon.headers.get('content-type')).toContain('image/svg+xml');
    expect(icon.headers.get('cache-control')).toBe('no-cache');
  });

  test('nothing outside the build directory is reachable', async () => {
    for (const path of ['/dashboard/..%2fsecret.txt', '/dashboard/%2e%2e/secret.txt', '/dashboard/assets/..%2f..%2fsecret.txt']) {
      expect(await (await site.request(path)).text(), path).not.toContain('secret');
    }
  });

  test('an unbuilt dashboard says so (503) instead of failing obscurely', async () => {
    const res = await createDashboardStatic(join(root, 'not-built')).request('/dashboard/');
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('npm --prefix web run build');
  });
});
