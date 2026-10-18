import { config } from '../config.ts';
import { getOrCreateUser, getUserByPhone, one, q } from '../db/index.ts';
import { runIn, type RunContext } from '../context.ts';
import { now } from '../clock.ts';
import { recordInbound, send } from '../transport/index.ts';
import type { RichContent } from '../transport/outbox.ts';
import { handleInbound } from '../agent/index.ts';
import { openInvitesFor, respondToInvite } from '../events/index.ts';
import type { User } from '../types.ts';
import { CODE_PLACEHOLDER, CONSENT, keyword, onboard, stepPrompt } from './onboarding.ts';

// The single entry for every inbound text: iMessage (Photon) and the dashboard.
//   1. validate; for iMessage, persist the provider id first (duplicates are processed once)
//   2. one text at a time per phone
//   3. demo numbers go straight to the agent (demo pool, never delivered)
//   4. real users, in the real pool: deterministic STOP / START / HELP, then onboarding (consent, name, UW email,
//      code) until verified, then the agent. From the dashboard ("acting as" them) nothing is delivered to them.

export type Via = 'phone' | 'dashboard';
export type ProcessResult = 'done' | 'duplicate' | 'ignored' | 'invalid';

export const MAX_TEXT = 5000; // tune: longest inbound text we act on
const MAX_PROVIDER_ID = 500;
export const E164 = /^\+[1-9]\d{7,14}$/;

const STOP_WORDS = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'END', 'QUIT']);
// Keywords only count as the whole message ("stop", "Stop!"), never as the first word of a sentence
// ("end of the week works"), so natural texts don't unsubscribe people.
const isStop = (word: string): boolean => STOP_WORDS.has(word) || STOP_WORDS.has(word.replace(/\s/g, ''));

export const STOP_ACK = "you're unsubscribed from mixr and won't get any more texts. Reply START to come back.";
export const HELP_TEXT =
  "mixr connects UW students with people and events that match their interests: text me what you're into or what you want to do, and i'll find your people. Message frequency varies. Reply STOP to unsubscribe.";
const SITE_URL = 'https://www.joinmixr.club';
const WELCOME_BACK = "welcome back to mixr! you'll get texts from me again. Reply STOP anytime to unsubscribe.";
const OOPS = 'sorry, something went wrong on my end. mind sending that again?';

// Per-phone chain: two texts from one phone run one after the other, different phones run concurrently.
const chains = new Map<string, Promise<void>>();
function serialize<T>(phone: string, fn: () => Promise<T>): Promise<T> {
  const run = (chains.get(phone) ?? Promise.resolve()).then(fn);
  const tail = run.then(
    () => {},
    () => {},
  );
  chains.set(phone, tail);
  void tail.then(() => {
    if (chains.get(phone) === tail) chains.delete(phone);
  });
  return run;
}

// Resolves with what happened; rejects only when processing itself failed (recorded for inspection first).
export function processText(phone: string, text: string, via: Via, providerId?: string): Promise<ProcessResult> {
  const body = typeof text === 'string' ? text.trim() : '';
  if (typeof phone !== 'string' || !E164.test(phone) || !body || body.length > MAX_TEXT) return Promise.resolve('invalid');
  if (via === 'phone' && (typeof providerId !== 'string' || !providerId || providerId.length > MAX_PROVIDER_ID)) return Promise.resolve('invalid');
  return serialize(phone, () => (via === 'phone' ? fromPhone(phone, body, providerId!) : route(phone, body, 'dashboard')));
}

async function fromPhone(phone: string, text: string, providerId: string): Promise<ProcessResult> {
  // Persisted before anything happens: a redelivery is a no-op, and a crash mid-processing leaves a
  // 'processing' row to inspect rather than blindly replaying side effects.
  const fresh = await one(
    `INSERT INTO inbound_messages (provider_id, phone) VALUES ($1, $2) ON CONFLICT (provider_id) DO NOTHING RETURNING provider_id`,
    [providerId, phone],
  );
  if (!fresh) return 'duplicate';
  try {
    const result = await route(phone, text, 'phone', providerId);
    await q(`UPDATE inbound_messages SET status = 'done', error = NULL WHERE provider_id = $1`, [providerId]);
    return result;
  } catch (e) {
    await q(`UPDATE inbound_messages SET status = 'failed', error = $2 WHERE provider_id = $1`, [providerId, sanitize(e)]).catch(() => {});
    await apologize(phone, providerId).catch(() => {});
    throw e;
  }
}

async function route(phone: string, text: string, via: Via, providerId?: string): Promise<ProcessResult> {
  const user = via === 'phone' ? await realUser(phone) : await getOrCreateUser(phone, { demo: true });
  if (user.seeded) {
    if (via === 'phone') return 'ignored'; // demo numbers are fake; never act on a real message for one
    await handleInbound(phone, text, 'dashboard');
    return 'done';
  }
  const ctx: RunContext = via === 'phone' ? { pool: 'real', deliver: true } : { pool: 'real', deliver: true, quietUser: user.id };
  const toAgent = await runIn(ctx, () => realTurn(user, text, via, providerId));
  if (toAgent) await handleInbound(phone, text, via, { recorded: true });
  return 'done';
}

// A number first seen over iMessage is a real user who starts at consent.
async function realUser(phone: string): Promise<User> {
  await q(`INSERT INTO users (phone, seeded, joined_via, step) VALUES ($1, false, 'imessage', 'consent') ON CONFLICT (phone) DO NOTHING`, [phone]);
  return (await getUserByPhone(phone))!;
}

// Deterministic handling for a real user. Returns true when the agent should take the text.
async function realTurn(user: User, text: string, via: Via, providerId?: string): Promise<boolean> {
  const word = keyword(text);
  const command = isStop(word) || word === 'HELP' || (user.optedOut && word === 'START');
  // Recorded exactly once, here (the agent is told it already is). Verification codes never reach the log.
  const redact = user.step === 'verify' && !command && word !== 'EMAIL';
  await recordInbound(user.id, redact ? CODE_PLACEHOLDER : text, via);

  const reply = (body: string, content?: RichContent) => send(user.id, body, { ...(providerId ? { dedupeKey: `reply:${providerId}` } : {}), content });
  if (isStop(word)) {
    await optOut(user, providerId);
    return false;
  }
  if (user.optedOut) {
    if (word !== 'START') return false; // deliberately silent until they come back
    await q(`UPDATE users SET opted_out = false WHERE id = $1`, [user.id]);
    await reply(!user.step ? WELCOME_BACK : user.step === 'consent' ? CONSENT : `welcome back! ${stepPrompt(user.step)}`);
    return false;
  }
  if (word === 'HELP') {
    await reply(HELP_TEXT, { kind: 'richlink', url: SITE_URL, caption: HELP_TEXT }); // the help text, then a link preview
    return false;
  }
  if (via === 'phone' && (await overLimit(user.id))) return false;
  if (user.step) {
    await reply(await onboard(user, text));
    return false;
  }
  return true;
}

// Per-person flood guard: past RATE_LIMIT texts in an hour, mixr says so once and then stays quiet until the
// hour rolls over. STOP, START and HELP are handled before this, so they always work.
export const RATE_LIMIT = 30; // tune: inbound texts per person per RATE_WINDOW_MS
export const RATE_WINDOW_MS = 60 * 60 * 1000;
export const RATE_LIMITED = "you're texting faster than i can keep up. give me a bit and i'll be back.";

async function overLimit(userId: number): Promise<boolean> {
  const since = new Date((await now()).getTime() - RATE_WINDOW_MS);
  const r = (await one<{ n: number }>(
    `SELECT count(*)::int AS n FROM messages WHERE user_id = $1 AND direction = 'in' AND via = 'phone' AND sim_time > $2`,
    [userId, since.toISOString()],
  ))!;
  if (r.n <= RATE_LIMIT) return false;
  if (r.n === RATE_LIMIT + 1) await send(userId, RATE_LIMITED, { dedupeKey: `rate-limited:${userId}:${since.toISOString().slice(0, 13)}` });
  return true;
}

async function optOut(user: User, providerId?: string): Promise<void> {
  // Takes effect first: nothing still queued for them goes out (except the acknowledgement below), and START
  // later can't revive stale texts.
  await q(`UPDATE users SET opted_out = true WHERE id = $1`, [user.id]);
  await q(
    `UPDATE message_jobs SET status = 'suppressed', error = 'suppressed after STOP'
     WHERE user_id = $1 AND status = 'pending' AND NOT even_if_opted_out`,
    [user.id],
  );
  // Give up their seats and answer pending invites, so hosts aren't left waiting on someone who left.
  for (const inv of await openInvitesFor(user.id)) {
    try {
      await respondToInvite(user.id, inv.id, inv.inviteStatus === 'invited' ? 'no_busy' : 'cancel');
    } catch {
      console.error(`Opt-out: could not release the invite for user ${user.id}, event ${inv.id}`);
    }
  }
  await send(user.id, STOP_ACK, { dedupeKey: providerId ? `stop-ack:${providerId}` : undefined, evenIfOptedOut: true });
}

// Something broke while handling a real iMessage: tell them, once, instead of going silent.
async function apologize(phone: string, providerId: string): Promise<void> {
  const u = await getUserByPhone(phone);
  if (!u || u.seeded) return;
  await runIn({ pool: 'real', deliver: true }, () => send(u.id, OOPS, { dedupeKey: `error:${providerId}` }));
}

const sanitize = (e: unknown): string =>
  (e instanceof Error ? e.message : String(e)).replaceAll(config.photonProjectSecret || '\u0000', '[redacted]').slice(0, 300);

// On startup: anything still 'processing' was interrupted by a crash or restart. Marked for inspection, never
// replayed automatically (its side effects may already have happened).
export async function markInterrupted(): Promise<number> {
  const rows = await q(
    `UPDATE inbound_messages SET status = 'failed', error = 'process interrupted; inspect before replaying' WHERE status = 'processing' RETURNING provider_id`,
  );
  return rows.length;
}
