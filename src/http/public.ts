import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getConnInfo } from '@hono/node-server/conninfo';
import { config } from '../config.ts';
import { one, q } from '../db/index.ts';
import { poolContext, runIn } from '../context.ts';
import { redirectLink, registerSharedUser } from '../messaging/photon-api.ts';
import { WELCOME } from '../messaging/onboarding.ts';
import { send } from '../transport/index.ts';

// Public, unauthenticated routes: the website's join endpoint and the health check.

export const publicApi = new Hono();

let ready = false;
export const setReady = (v: boolean): void => void (ready = v);

publicApi.get('/health', (c) => c.json({ ready }, ready ? 200 : 503));

// POST /join {phone} from the website. Registers the number with Photon's shared line (which assigns the number
// they'll text mixr at) and creates the real user. By default they text first and /join sends nothing; with
// WELCOME_TEXT=on, mixr texts first: one welcome (which is also the consent ask) to someone it has never texted.
//   200 {ok:true, number, link, welcome}  link = tap-to-text deep link with "hi mixr" prefilled; welcome = a text is on its way
//   400 invalid number · 409 {full:true} plan cap reached · 413 body too big · 429 rate limited · 502 upstream failure
// Every valid number gets the same shape of answer, registered before or not.

const JOIN_MAX_BODY = 1024; // bytes
const JOIN_LIMIT = 5; // tune: attempts per IP...
const JOIN_WINDOW_MS = 10 * 60_000; // tune: ...per this window
const JOIN_MAX_IPS = 10_000; // tune: memory cap on the rate table
const DEV_JOIN_NUMBER = '+15555550100';
const JOIN_MSG = 'hi mixr';

const FULL = "mixr's full rn. more spots soon";
const BAD_PHONE = "that's not a US number. try again?";
const FAILED = 'something broke on my end. try again in a minute';

const joinOrigin = (origin: string | undefined): string | null => {
  if (!origin) return null;
  if (config.joinOrigins.includes(origin)) return origin;
  if (!config.production && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
  return null;
};

const joinHeaders: MiddlewareHandler = async (c, next) => {
  c.header('Vary', 'Origin');
  c.header('Cache-Control', 'no-store');
  const origin = joinOrigin(c.req.header('origin'));
  if (origin) c.header('Access-Control-Allow-Origin', origin);
  await next();
};

// Behind Cloudflare / a proxy the socket is the proxy, so prefer the forwarded client address.
function clientIp(c: Context): string {
  const cf = c.req.header('cf-connecting-ip')?.trim();
  if (cf) return cf;
  const xff = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
  if (xff) return xff;
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown'; // no socket (app.request in tests)
  }
}

// In-memory, per process (one instance). Wall clock, never the demo clock.
const hits = new Map<string, number[]>();
const joinRateLimit: MiddlewareHandler = async (c, next) => {
  const ip = clientIp(c);
  const t = Date.now();
  const recent = (hits.get(ip) ?? []).filter((x) => t - x < JOIN_WINDOW_MS);
  if (hits.size > JOIN_MAX_IPS) hits.clear();
  hits.set(ip, [...recent, t]);
  if (recent.length >= JOIN_LIMIT) return c.json({ ok: false, error: "that's a lot of tries. give it a few minutes" }, 429);
  await next();
};

// Bare 10/11-digit numbers are US (+1); anything else must be typed as +E.164.
export function normalizePhone(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  const digits = s.replace(/\D/g, '');
  const phone = s.startsWith('+')
    ? '+' + digits
    : digits.length === 10
      ? '+1' + digits
      : digits.length === 11 && digits[0] === '1'
        ? '+' + digits
        : '';
  return /^\+[1-9]\d{7,14}$/.test(phone) ? phone : null;
}

// The real user behind a joined number. Existing users keep their progress (and pool); only the Photon ids update.
async function upsertJoined(phone: string, photonUserId: string | null, assignedNumber: string): Promise<void> {
  await q(
    `INSERT INTO users (phone, seeded, joined_via, step, photon_user_id, assigned_number) VALUES ($1, false, 'web', 'consent', $2, $3)
     ON CONFLICT (phone) DO UPDATE SET photon_user_id = coalesce(EXCLUDED.photon_user_id, users.photon_user_id),
       assigned_number = EXCLUDED.assigned_number
     WHERE NOT users.seeded`,
    [phone, photonUserId, assignedNumber],
  );
}

// WELCOME_TEXT=on: queue the welcome for someone mixr has never texted (repeat joins and onboarded users get
// nothing). Returns whether one is on its way. Delivery runs after the response; failures are logged, never thrown.
async function welcome(phone: string): Promise<boolean> {
  if (!config.welcomeText) return false;
  try {
    const u = await one<{ id: number }>(
      `SELECT id FROM users u WHERE phone = $1 AND NOT seeded AND NOT opted_out
       AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.user_id = u.id AND m.direction = 'out')`,
      [phone],
    );
    if (!u) return false;
    const key = `welcome:${u.id}`;
    void runIn(poolContext('real'), () => send(u.id, WELCOME, { dedupeKey: key }))
      .then(async () => {
        // The outbox swallows provider errors into the job row; surface them here. No job = sim transport.
        const j = await one<{ status: string; error: string | null }>(`SELECT status, error FROM message_jobs WHERE dedupe_key = $1`, [key]);
        if (!j || j.status === 'sent') return;
        console.warn(
          `Welcome text for user ${u.id} not delivered (${j.status}${j.error ? `: ${j.error}` : ', Photon not connected; the ticker retries'}). ` +
            `Photon may refuse to start a conversation with a number that hasn't texted; set WELCOME_TEXT=off if this keeps happening.`,
        );
      })
      .catch((e) => console.error(`Welcome text for user ${u.id} failed: ${e instanceof Error ? e.message : String(e)}`));
    return true;
  } catch (e) {
    console.error(`Welcome text check failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

publicApi.options('/join', joinHeaders, (c) => {
  c.header('Access-Control-Allow-Methods', 'POST');
  c.header('Access-Control-Allow-Headers', 'Content-Type');
  c.header('Access-Control-Max-Age', '600');
  return c.body(null, 204);
});

publicApi.post(
  '/join',
  joinHeaders,
  joinRateLimit,
  bodyLimit({ maxSize: JOIN_MAX_BODY, onError: (c) => c.json({ ok: false, error: 'Request too large.' }, 413) }),
  async (c) => {
    const body = await c.req.json().catch(() => null);
    const phone = normalizePhone(body && typeof body === 'object' ? (body as { phone?: unknown }).phone : undefined);
    if (!phone) return c.json({ ok: false, error: BAD_PHONE }, 400);
    try {
      if (config.transport !== 'photon') {
        // Dev / tests: no Photon. A stand-in number; the user can be "acted as" from the dashboard.
        const env = process.env.DEV_JOIN_NUMBER?.trim();
        const number = env && /^\+[1-9]\d{7,14}$/.test(env) ? env : DEV_JOIN_NUMBER;
        await upsertJoined(phone, null, number);
        return c.json({ ok: true, number, link: `sms:${number}&body=${encodeURIComponent(JOIN_MSG)}`, welcome: await welcome(phone) });
      }
      const r = await registerSharedUser(phone);
      if (r.kind === 'full') {
        console.warn('Join refused: Photon shared-user cap reached.');
        return c.json({ ok: false, full: true, error: FULL }, 409);
      }
      if (r.kind === 'error') {
        console.error(`Join failed: Photon registration error${r.status ? ` (HTTP ${r.status})` : ''}: ${r.message}`);
        return c.json({ ok: false, error: FAILED }, 502);
      }
      await upsertJoined(phone, r.id, r.assignedPhoneNumber);
      return c.json({ ok: true, number: r.assignedPhoneNumber, link: redirectLink(r.id, JOIN_MSG), welcome: await welcome(phone) });
    } catch (e) {
      console.error(`Join failed: ${e instanceof Error ? e.message : String(e)}`);
      return c.json({ ok: false, error: FAILED }, 502);
    }
  },
);
