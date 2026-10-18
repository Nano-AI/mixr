import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { getConnInfo } from '@hono/node-server/conninfo';
import { config } from '../config.ts';

// Admin login for the dashboard and /api/*.
//   Bearer: `Authorization: Bearer <ADMIN_TOKEN>` (scripts, curl).
//   Session cookie (the dashboard): mixr_session = HMAC-SHA256(ADMIN_TOKEN, "session:" + issuedAt) "." issuedAt.
//     Stateless, so rotating ADMIN_TOKEN signs everyone out. Host-only (no Domain): works on whatever hostname
//     the server is reached on.
//   No ADMIN_TOKEN: open in local dev, locked (503) in production.
// config is read per request, never captured at import, so tests and restarts see the current value.
// Wall clock on purpose: sessions and lockouts are real-world time, never the demo clock.

export const SESSION_COOKIE = 'mixr_session';
// The dashboard sends this on every request. Cookies ride along on requests other sites trigger; a plain form or
// link can't add a custom header, so cookie-authenticated writes without it are refused (bearer calls don't need it).
export const DASHBOARD_HEADER = 'x-mixr-dashboard';

const SESSION_TTL_MS = 7 * 24 * 60 * 60_000; // tune: session lifetime
const CLOCK_SKEW_MS = 60_000; // tune: accept a session issued up to this far "in the future"
const MAX_FAILURES = 10; // tune: wrong tokens per IP...
const FAILURE_WINDOW_MS = 15 * 60_000; // tune: ...within this window locks that IP out until the oldest ages out
const MAX_TRACKED_IPS = 10_000; // tune: memory cap on the failure table

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const sha256 = (s: string): Buffer => createHash('sha256').update(s).digest();
// Constant time regardless of length: compare fixed-size digests.
const sameToken = (given: string, expected: string): boolean => timingSafeEqual(sha256(given), sha256(expected));
const mac = (token: string, issuedAt: number): string => createHmac('sha256', token).update(`session:${issuedAt}`).digest('base64url');

export const sessionValue = (token: string, issuedAt: number): string => `${mac(token, issuedAt)}.${issuedAt}`;

export function validSession(value: string | undefined, token: string, nowMs = Date.now()): boolean {
  if (!value || !token) return false;
  const dot = value.lastIndexOf('.');
  const issued = value.slice(dot + 1);
  if (dot <= 0 || !/^\d{1,15}$/.test(issued)) return false;
  const issuedAt = Number(issued);
  if (issuedAt > nowMs + CLOCK_SKEW_MS || nowMs - issuedAt > SESSION_TTL_MS) return false;
  const got = Buffer.from(value.slice(0, dot));
  const want = Buffer.from(mac(token, issuedAt));
  return got.length === want.length && timingSafeEqual(got, want);
}

// Behind Cloudflare / a reverse proxy the socket address is the proxy, so prefer the forwarded client address.
export function clientIp(c: Context): string {
  const cf = c.req.header('cf-connecting-ip')?.trim();
  if (cf) return cf;
  const xff = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
  if (xff) return xff;
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown'; // no socket (e.g. app.request in tests)
  }
}

const isHttps = (c: Context): boolean =>
  c.req.header('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase() === 'https' || new URL(c.req.url).protocol === 'https:';

// ---- brute-force guard: per-IP failure timestamps (oldest first), in memory ----

const failures = new Map<string, number[]>();

function recentFailures(ip: string, nowMs: number): number[] {
  const list = (failures.get(ip) ?? []).filter((t) => nowMs - t < FAILURE_WINDOW_MS);
  if (list.length) failures.set(ip, list);
  else failures.delete(ip);
  return list;
}

// Seconds until this IP may try again; 0 = not locked.
function lockedFor(ip: string, nowMs: number): number {
  const list = recentFailures(ip, nowMs);
  if (list.length < MAX_FAILURES) return 0;
  return Math.max(1, Math.ceil((list[list.length - MAX_FAILURES]! + FAILURE_WINDOW_MS - nowMs) / 1000));
}

function recordFailure(ip: string, nowMs: number): void {
  const list = recentFailures(ip, nowMs);
  list.push(nowMs);
  failures.set(ip, list);
  if (failures.size > MAX_TRACKED_IPS) failures.delete(failures.keys().next().value!);
}

const tooMany = (c: Context, seconds: number) => {
  c.header('Retry-After', String(seconds));
  return c.json({ ok: false, error: 'too many attempts, try again later', retryAfter: seconds }, 429);
};

const unauthorized = (c: Context) => {
  c.header('WWW-Authenticate', 'Bearer realm="mixr"');
  return c.json({ ok: false, error: 'unauthorized' }, 401);
};

const notConfigured = (c: Context) => c.json({ ok: false, authenticated: false, error: 'ADMIN_TOKEN not set' }, 503);

// null = no Authorization header; '' = a header that isn't a usable bearer token.
function bearer(c: Context): string | null {
  const h = c.req.header('authorization');
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1]!.trim() : '';
}

// ---- /api/* gate ----

export const requireAdmin: MiddlewareHandler = async (c, next) => {
  const token = config.adminToken;
  if (!token) {
    if (config.production) return notConfigured(c);
    return next(); // local dev without a token: open
  }
  const nowMs = Date.now();

  const given = bearer(c);
  if (given !== null) {
    const ip = clientIp(c);
    const wait = lockedFor(ip, nowMs);
    if (wait) return tooMany(c, wait);
    if (given && sameToken(given, token)) return next();
    recordFailure(ip, nowMs);
    return unauthorized(c);
  }

  if (!validSession(getCookie(c, SESSION_COOKIE), token, nowMs)) return unauthorized(c);
  if (!SAFE_METHODS.has(c.req.method) && !c.req.header(DASHBOARD_HEADER)) {
    return c.json({ ok: false, error: `missing ${DASHBOARD_HEADER} header` }, 403);
  }
  return next();
};

// ---- /auth: login, logout, me (mount at /auth) ----

export const authApi = new Hono();

authApi.use('*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
});

authApi.post('/login', async (c) => {
  const token = config.adminToken;
  if (!token) return config.production ? notConfigured(c) : c.json({ ok: true, authenticated: true, open: true });

  const ip = clientIp(c);
  const nowMs = Date.now();
  const wait = lockedFor(ip, nowMs);
  if (wait) return tooMany(c, wait);

  const body = (await c.req.json().catch(() => null)) as { token?: unknown } | null;
  const given = typeof body?.token === 'string' ? body.token.trim() : '';
  if (!given) return c.json({ ok: false, error: 'token is required' }, 400);
  if (!sameToken(given, token)) {
    recordFailure(ip, nowMs);
    return c.json({ ok: false, error: 'invalid token' }, 401);
  }

  failures.delete(ip);
  setCookie(c, SESSION_COOKIE, sessionValue(token, nowMs), {
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
    secure: isHttps(c),
    maxAge: SESSION_TTL_MS / 1000,
  });
  return c.json({ ok: true, authenticated: true, open: false });
});

authApi.post('/logout', (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: '/', httpOnly: true, sameSite: 'Lax', secure: isHttps(c) });
  return c.json({ ok: true, authenticated: false });
});

// Cookie only (no bearer here), so this can't be used to guess tokens without hitting the lockout.
authApi.get('/me', (c) => {
  const token = config.adminToken;
  if (!token) return config.production ? notConfigured(c) : c.json({ authenticated: true, open: true });
  return c.json({ authenticated: validSession(getCookie(c, SESSION_COOKIE), token), open: false });
});
