import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { fresh } from './helpers.ts';
import { getUserByPhone, one, q } from '../src/db/index.ts';
import { config } from '../src/config.ts';
import { publicApi } from '../src/http/public.ts';
import { adminApi } from '../src/http/admin.ts';
import { setPhotonFetch } from '../src/messaging/photon-api.ts';
import { retryPending, setDeliverer } from '../src/transport/outbox.ts';
import { processText } from '../src/messaging/pipeline.ts';
import { CONSENT, WELCOME } from '../src/messaging/onboarding.ts';

// POST /join (website) and the admin messaging views. Photon is always a fake fetch here: the real API has a
// 10-user cap and every new registration uses a slot.

const PROJECT = '00000000-0000-0000-0000-000000000000';
const original = { ...config, joinOrigins: [...config.joinOrigins] };
let ip = 0;

beforeEach(async () => {
  await fresh();
  ip++;
});
afterEach(() => {
  Object.assign(config, original);
  setPhotonFetch(null);
  setDeliverer(null);
  delete process.env.DEV_JOIN_NUMBER;
});

const join = (body: unknown, headers: Record<string, string> = {}) =>
  publicApi.request('/join', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': `10.0.0.${ip}`, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

type Call = { url: string; init: RequestInit };
function photon(respond: (call: Call) => Response | Promise<Response>) {
  config.transport = 'photon';
  config.photonProjectId = PROJECT;
  config.photonProjectSecret = 'test-secret';
  const calls: Call[] = [];
  setPhotonFetch((async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return respond(call);
  }) as typeof fetch);
  return calls;
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const created = (phoneNumber: string, id = '11111111-2222-4333-8444-555555555555') =>
  json(200, {
    succeed: true,
    data: { id, projectId: PROJECT, type: 'shared', firstName: null, lastName: null, email: null, phoneNumber, assignedPhoneNumber: '+16285550199', meta: null, createdAt: '2026-10-17T00:00:00Z' },
  });

test('sim transport: a stand-in number and sms link, a real user waiting at consent, and no text sent', async () => {
  const res = await join({ phone: '(425) 555-0100' });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, number: '+15555550100', link: 'sms:+15555550100&body=hi%20mixr', welcome: false });
  expect(await getUserByPhone('+14255550100')).toMatchObject({ seeded: false, step: 'consent', joinedVia: 'web', assignedNumber: '+15555550100' });
  expect((await q(`SELECT 1 FROM messages`)).length).toBe(0);
  expect((await q(`SELECT 1 FROM message_jobs`)).length).toBe(0);

  process.env.DEV_JOIN_NUMBER = '+12065550199';
  expect(await (await join({ phone: '1-425-555-0100' })).json()).toEqual({ ok: true, number: '+12065550199', link: 'sms:+12065550199&body=hi%20mixr', welcome: false });
  expect((await q(`SELECT 1 FROM users`)).length).toBe(1);
});

test('US numbers normalize to +1; anything else must be +E.164', async () => {
  for (const phone of ['4255550101', '425.555.0102', '+1 (425) 555-0103', '14255550104', '+447700900123']) expect((await join({ phone })).status).toBe(200);
  ip++;
  for (const body of [{ phone: '555-0100' }, { phone: 42 }, {}, 'not json', { phone: '2' + '0'.repeat(10) }]) {
    const res = await join(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: "that's not a US number. try again?" });
  }
  expect((await q(`SELECT phone FROM users ORDER BY id`)).map((r) => r.phone)).toEqual(['+14255550101', '+14255550102', '+14255550103', '+14255550104', '+447700900123']);
});

test('bodies over 1KB are refused', async () => {
  const res = await join({ phone: '4255550100', pad: 'x'.repeat(2000) });
  expect(res.status).toBe(413);
  expect((await q(`SELECT 1 FROM users`)).length).toBe(0);
});

test('rate limit: 5 tries per IP per 10 minutes, keyed on CF-Connecting-IP, then X-Forwarded-For', async () => {
  for (let i = 0; i < 5; i++) expect((await join({ phone: `42555501${10 + i}` })).status).toBe(200);
  const res = await join({ phone: '4255550199' });
  expect(res.status).toBe(429);
  expect((await res.json()).ok).toBe(false);
  expect((await join({ phone: '4255550199' }, { 'CF-Connecting-IP': '10.9.9.9' })).status).toBe(200);

  // Without Cloudflare's header, the first X-Forwarded-For hop is the client.
  const xff = (n: number) => join({ phone: `42555502${10 + n}` }, { 'CF-Connecting-IP': '', 'X-Forwarded-For': '192.0.2.7, 10.0.0.1' });
  for (let i = 0; i < 5; i++) expect((await xff(i)).status).toBe(200);
  expect((await xff(9)).status).toBe(429);
});

test('CORS: only the configured origins (plus localhost outside production)', async () => {
  const preflight = (origin: string) => publicApi.request('/join', { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' } });
  const ok = await preflight('https://joinmixr.club');
  expect(ok.status).toBe(204);
  expect(ok.headers.get('access-control-allow-origin')).toBe('https://joinmixr.club');
  expect(ok.headers.get('access-control-allow-methods')).toBe('POST');
  expect(ok.headers.get('access-control-allow-headers')).toBe('Content-Type');
  expect(ok.headers.get('vary')).toBe('Origin');
  expect((await preflight('https://evil.example')).headers.get('access-control-allow-origin')).toBeNull();
  expect((await preflight('http://localhost:5173')).headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
  config.production = true;
  expect((await preflight('http://localhost:5173')).headers.get('access-control-allow-origin')).toBeNull();

  const post = await join({ phone: '4255550104' }, { Origin: 'https://www.joinmixr.club' });
  expect(post.headers.get('access-control-allow-origin')).toBe('https://www.joinmixr.club');
  // Errors carry CORS headers too, so the page can show them.
  expect((await join({ phone: 'nope' }, { Origin: 'https://joinmixr.club' })).headers.get('access-control-allow-origin')).toBe('https://joinmixr.club');
});

test('photon: registers a shared user, stores the assignment, answers with the number and tap-to-text link', async () => {
  const calls = photon(() => created('+14255550100'));
  const res = await join({ phone: '425-555-0100' });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    ok: true,
    number: '+16285550199',
    link: 'https://spectrum.photon.codes/users/11111111-2222-4333-8444-555555555555/redirect?msg=hi%20mixr',
    welcome: false,
  });
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe(`https://spectrum.photon.codes/projects/${PROJECT}/users/`);
  expect(calls[0].init.method).toBe('POST');
  const headers = new Headers(calls[0].init.headers);
  expect(headers.get('authorization')).toBe(`Basic ${Buffer.from(`${PROJECT}:test-secret`).toString('base64')}`);
  expect(JSON.parse(String(calls[0].init.body))).toEqual({ type: 'shared', phoneNumber: '+14255550100' });
  expect(await getUserByPhone('+14255550100')).toMatchObject({ seeded: false, step: 'consent', joinedVia: 'web', assignedNumber: '+16285550199' });
  expect((await one(`SELECT photon_user_id FROM users WHERE phone = '+14255550100'`))!.photon_user_id).toBe('11111111-2222-4333-8444-555555555555');
  expect((await q(`SELECT 1 FROM messages`)).length).toBe(0); // WELCOME_TEXT off: they text first

  // Already registered (and already onboarded): same answer, progress untouched.
  await q(`UPDATE users SET step = NULL, email_verified = true WHERE phone = '+14255550100'`);
  const again = await join({ phone: '+14255550100' });
  expect(again.status).toBe(200);
  expect((await again.json()).number).toBe('+16285550199');
  expect(await getUserByPhone('+14255550100')).toMatchObject({ step: null, emailVerified: true });
});

const outbound = async (phone: string) =>
  (await q<{ text: string }>(`SELECT m.text FROM messages m JOIN users u ON u.id = m.user_id WHERE u.phone = $1 AND m.direction = 'out' ORDER BY m.id`, [phone])).map((r) => r.text);

test('WELCOME_TEXT=on, photon: exactly one welcome reaches the deliverer for a never-texted number; a repeat join sends nothing', async () => {
  config.welcomeText = true;
  photon(() => created('+14255550100'));
  const sent: { phone: string; text: string }[] = [];
  setDeliverer(async (phone, text) => void sent.push({ phone, text }));

  const res = await join({ phone: '425-555-0100' });
  expect((await res.json()).welcome).toBe(true);
  await vi.waitFor(async () => expect((await q(`SELECT status FROM message_jobs WHERE status = 'sent'`)).length).toBe(1));
  const u = (await getUserByPhone('+14255550100'))!;
  expect(await one(`SELECT dedupe_key, text FROM message_jobs`)).toEqual({ dedupe_key: `welcome:${u.id}`, text: WELCOME });
  expect(sent).toEqual([{ phone: '+14255550100', text: WELCOME }]);

  const again = await join({ phone: '4255550100' });
  expect((await again.json()).welcome).toBe(false);
  await new Promise((r) => setTimeout(r, 50));
  expect(sent).toHaveLength(1);
  expect(await outbound('+14255550100')).toEqual([WELCOME]);
  expect(u.step).toBe('consent');
});

test('WELCOME_TEXT=on: a "yes" opts in without a second greeting; anything else gets the ask, not another hello', async () => {
  config.welcomeText = true;
  expect((await (await join({ phone: '4255550101' })).json()).welcome).toBe(true);
  await vi.waitFor(async () => expect(await outbound('+14255550101')).toEqual([WELCOME]));
  await processText('+14255550101', 'yes!', 'phone', 'imessage:w1');
  expect(await outbound('+14255550101')).toEqual([WELCOME, "you're in! what's your full name? (first and last)"]);
  expect((await getUserByPhone('+14255550101'))!.step).toBe('name');

  ip++;
  await join({ phone: '4255550102' });
  await vi.waitFor(async () => expect(await outbound('+14255550102')).toEqual([WELCOME]));
  await processText('+14255550102', 'hi mixr', 'phone', 'imessage:w2'); // the landing page's prefilled text
  const [, reply] = await outbound('+14255550102');
  expect(reply).toMatch(/^reply YES to opt in/);
  expect(reply).not.toBe(CONSENT);
  await processText('+14255550102', 'yes', 'phone', 'imessage:w3');
  expect((await getUserByPhone('+14255550102'))!.step).toBe('name');
});

test('WELCOME_TEXT=on: a welcome Photon refused does not count as consent; their first text gets the full disclosure', async () => {
  config.welcomeText = true;
  photon(() => created('+14255550103'));
  setDeliverer(async () => {
    throw new Error('Target not allowed for this project');
  });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await join({ phone: '4255550103' });
  await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^Welcome text for user \d+ not delivered \(pending: Target not allowed/)));
  warn.mockRestore();
  setDeliverer(async () => {});
  await processText('+14255550103', 'yes', 'phone', 'imessage:w4');
  expect((await outbound('+14255550103')).at(-1)).toBe(CONSENT);
  expect((await getUserByPhone('+14255550103'))!.step).toBe('consent');
});

test('WELCOME_TEXT=on: a refused welcome still pending is dropped when they text in, and their "hi" gets the full disclosure', async () => {
  config.welcomeText = true;
  photon(() => created('+14255550104'));
  setDeliverer(async () => {
    throw new Error('Target not allowed for this project');
  });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await join({ phone: '4255550104' });
  await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^Welcome text for user \d+ not delivered/)));
  warn.mockRestore();
  const u = (await getUserByPhone('+14255550104'))!;
  const welcomeJob = () => one(`SELECT status, attempts, error FROM message_jobs WHERE dedupe_key = $1`, [`welcome:${u.id}`]);
  expect(await welcomeJob()).toMatchObject({ status: 'pending', attempts: 1 });
  // Another pending job from before the inbound that isn't the welcome is left alone.
  await q(`INSERT INTO message_jobs (user_id, message_id, dedupe_key, text) SELECT $1, id, 'other', 'something else' FROM messages WHERE user_id = $1`, [u.id]);

  const sent: string[] = [];
  setDeliverer(async (_phone, text) => void sent.push(text));
  await processText('+14255550104', 'hi', 'phone', 'imessage:w5');
  expect(sent).toEqual([CONSENT]);
  expect(await outbound('+14255550104')).toEqual([WELCOME, CONSENT]);
  expect(await welcomeJob()).toMatchObject({ status: 'suppressed', attempts: 1, error: expect.stringMatching(/texted in before the welcome/) });
  expect((await one(`SELECT status FROM message_jobs WHERE dedupe_key = 'other'`))!.status).toBe('pending');
  expect((await one(`SELECT status FROM message_jobs WHERE dedupe_key = 'reply:imessage:w5'`))!.status).toBe('sent');
  await retryPending(); // the retry loop never sends the stale welcome
  expect(sent).toEqual([CONSENT, 'something else']);

  // The disclosure reached them, so YES opts in.
  await processText('+14255550104', 'yes', 'phone', 'imessage:w6');
  expect((await getUserByPhone('+14255550104'))!.step).toBe('name');
});

test('a welcome that gave up (failed) does not count either; the failed job is left as it is', async () => {
  config.transport = 'photon';
  const u = (await one<{ id: number }>(`INSERT INTO users (phone, seeded, joined_via, step) VALUES ('+14255550106', false, 'web', 'consent') RETURNING id`))!;
  const m = (await one<{ id: number }>(`INSERT INTO messages (user_id, direction, text, sim_time, via) VALUES ($1, 'out', $2, now(), 'system') RETURNING id`, [u.id, WELCOME]))!;
  await q(`INSERT INTO message_jobs (user_id, message_id, dedupe_key, text, status, attempts) VALUES ($1, $2, $3, $4, 'failed', 3)`, [u.id, m.id, `welcome:${u.id}`, WELCOME]);
  const sent: string[] = [];
  setDeliverer(async (_phone, text) => void sent.push(text));
  await processText('+14255550106', 'hi', 'phone', 'imessage:w9');
  expect(sent).toEqual([CONSENT]);
  expect((await one(`SELECT status FROM message_jobs WHERE dedupe_key = $1`, [`welcome:${u.id}`]))!.status).toBe('failed');
});

test('WELCOME_TEXT=on, photon: a delivered welcome counts as the disclosure; a reply that is not YES gets the short ask', async () => {
  config.welcomeText = true;
  photon(() => created('+14255550105'));
  const sent: string[] = [];
  setDeliverer(async (_phone, text) => void sent.push(text));
  await join({ phone: '4255550105' });
  await vi.waitFor(async () => expect((await q(`SELECT 1 FROM message_jobs WHERE status = 'sent'`)).length).toBe(1));
  await processText('+14255550105', 'hi mixr', 'phone', 'imessage:w7');
  expect(sent).toEqual([WELCOME, expect.stringMatching(/^reply YES to opt in/)]);
  expect(sent[1]).not.toBe(CONSENT);
  expect((await getUserByPhone('+14255550105'))!.step).toBe('consent');
  await processText('+14255550105', 'yes', 'phone', 'imessage:w8');
  expect((await getUserByPhone('+14255550105'))!.step).toBe('name');
});

test('a consent text Photon refused does not count: their YES gets the disclosure again', async () => {
  config.transport = 'photon';
  setDeliverer(async () => {
    throw new Error('Target not allowed for this project');
  });
  await processText('+14255550107', 'hi', 'phone', 'imessage:c1');
  expect((await one(`SELECT status FROM message_jobs WHERE dedupe_key = 'reply:imessage:c1'`))!.status).toBe('pending');
  const sent: string[] = [];
  setDeliverer(async (_phone, text) => void sent.push(text));
  await processText('+14255550107', 'yes', 'phone', 'imessage:c2');
  expect(sent).toEqual([CONSENT]);
  expect((await getUserByPhone('+14255550107'))!.step).toBe('consent');
  await processText('+14255550107', 'yes', 'phone', 'imessage:c3');
  expect((await getUserByPhone('+14255550107'))!.step).toBe('name');
});

test('photon: plan cap reached -> 409 full, nobody created', async () => {
  photon(() => json(403, { succeed: false, data: null, code: 'FORBIDDEN', message: 'Project has reached maxSharedUsers (10)' }));
  const res = await join({ phone: '4255550100' });
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ ok: false, full: true, error: "mixr's full rn. more spots soon" });
  expect((await q(`SELECT 1 FROM users`)).length).toBe(0);
});

test('photon: other failures -> 502 with a generic message', async () => {
  const failures = [
    () => json(500, { succeed: false, data: null, code: 'INTERNAL', message: 'boom' }),
    () => json(400, { succeed: false, data: null, code: 'VALIDATION_ERROR', message: 'phoneNumber exceeds maxLength' }),
    () => json(429, { succeed: false, data: null, code: 'RATE_LIMITED', message: 'rate limit exceeded' }),
    () => json(200, { succeed: true, data: { id: 'x' } }),
    () => {
      throw new TypeError('fetch failed');
    },
  ];
  for (const [i, respond] of failures.entries()) {
    photon(respond);
    const res = await join({ phone: `42555501${10 + i}` });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, error: 'something broke on my end. try again in a minute' });
  }
  expect((await q(`SELECT 1 FROM users`)).length).toBe(0);
});

test('photon: never called for real from tests', async () => {
  config.transport = 'photon';
  config.photonProjectId = PROJECT;
  config.photonProjectSecret = 'test-secret';
  setPhotonFetch(null);
  expect((await join({ phone: '4255550100' })).status).toBe(502);
});

test('admin: delivery records without text; unfinished inbound only', async () => {
  const u = await one<{ id: number }>(`INSERT INTO users (phone, seeded) VALUES ('+14255550100', false) RETURNING id`);
  await q(`INSERT INTO message_jobs (user_id, dedupe_key, text, status) VALUES ($1, 'k1', 'secret text', 'sent')`, [u!.id]);
  await q(`INSERT INTO inbound_messages (provider_id, phone, status) VALUES ('a', '+14255550100', 'done'), ('b', '+14255550100', 'failed'), ('c', '+14255550100', 'processing')`);
  const jobs = await (await adminApi.request('/messages')).json();
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({ userId: u!.id, dedupeKey: 'k1', status: 'sent' });
  expect(JSON.stringify(jobs)).not.toContain('secret text');
  const inbound = await (await adminApi.request('/inbound')).json();
  expect(inbound.map((r: { providerId: string }) => r.providerId).sort()).toEqual(['b', 'c']);
});

test('admin /note: validated, real users only, stored for the next delivered text', async () => {
  const note = (body: unknown) =>
    adminApi.request('/note', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const u = (await one<{ id: number }>(`INSERT INTO users (phone, seeded) VALUES ('+14255550100', false) RETURNING id`))!;
  await q(`INSERT INTO users (phone, seeded) VALUES ('+15555550123', true)`);
  for (const body of [{}, 'not json', { phone: '+14255550100' }, { note: 'hi' }, { phone: '+14255550100', note: '   ' }, { phone: '+14255550100', note: 7 }, { phone: '+14255550100', note: 'x'.repeat(301) }]) {
    const res = await note(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'phone and note (<= 300 chars) are required' });
  }
  expect((await note({ phone: '+14255550199', note: 'hello' })).status).toBe(404);
  expect((await note({ phone: '+15555550123', note: 'hello' })).status).toBe(404); // demo user
  expect((await one(`SELECT pending_note FROM users WHERE id = $1`, [u.id]))!.pending_note).toBeNull();

  const ok = await note({ phone: ' +14255550100 ', note: '  sorry for the\n mixup earlier  ' });
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual({ ok: true });
  expect((await one(`SELECT pending_note FROM users WHERE id = $1`, [u.id]))!.pending_note).toBe('sorry for the mixup earlier');
  expect((await note({ phone: '+14255550100', note: 'y'.repeat(300) })).status).toBe(200); // replaces it; 300 is fine
  expect((await one(`SELECT pending_note FROM users WHERE id = $1`, [u.id]))!.pending_note).toBe('y'.repeat(300));
  expect((await q(`SELECT 1 FROM messages`)).length).toBe(0); // sends nothing by itself
});
