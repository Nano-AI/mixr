import { one, q } from '../db/index.ts';
import { config } from '../config.ts';
import { context } from '../context.ts';
import { trace } from '../trace.ts';

// Durable delivery of outbound texts to real users (Photon iMessage). One row per logical notification, keyed by
// dedupe_key, so a retry or a replayed inbound never double-texts. 'sent' means the provider accepted it, not that
// the phone showed it. Failed sends retry from the ticker, up to MAX_ATTEMPTS.

const MAX_ATTEMPTS = 3; // tune:
const RETRY_WINDOW_H = 24; // tune: older failures are left alone (stale context)

// Native iMessage extras for one outbound job. `text` is always stored too: it's the log line and the plain
// fallback the deliverer sends if Photon rejects (or doesn't support) the rich form. `caption`, when set, goes out
// as a plain bubble right before the rich part.
export const TAPBACKS = ['❤️', '👍', '😂', '‼️'] as const;
export type Tapback = (typeof TAPBACKS)[number];
export type RichContent = (
  | { kind: 'contact'; first: string; last?: string; phone: string; mixrPhoto?: boolean } // vCard attachment
  | { kind: 'effect'; effect: 'confetti' } // text sent with a screen effect
  | { kind: 'reaction'; emoji: Tapback; targetId: string | null } // tapback on an inbound message (provider id)
  | { kind: 'reply'; targetId: string } // text threaded under an inbound message
  | { kind: 'poll'; title: string; options: string[] }
  | { kind: 'richlink'; url: string } // link preview
  | { kind: 'share_contact' } // Apple's Share Name and Photo; best effort, no text fallback
) & { caption?: string };

type Deliverer = (phone: string, text: string, content: RichContent | null) => Promise<void>;
let deliverer: Deliverer | null = null;

// The Photon adapter registers itself once connected. Without one, jobs wait as 'pending' for the retry loop.
export const setDeliverer = (fn: Deliverer | null): void => void (deliverer = fn);

export async function queueDelivery(
  userId: number,
  messageId: number | null,
  text: string,
  opts: { dedupeKey?: string; evenIfOptedOut?: boolean; content?: RichContent },
): Promise<void> {
  const ctx = context();
  if (config.transport !== 'photon' || ctx.pool !== 'real' || !ctx.deliver || ctx.quietUser === userId) return;
  const u = await one<{ phone: string; seeded: boolean; opted_out: boolean }>('SELECT phone, seeded, opted_out FROM users WHERE id = $1', [userId]);
  if (!u || u.seeded || (u.opted_out && !opts.evenIfOptedOut)) return;
  const job = await one<{ id: number }>(
    `INSERT INTO message_jobs (user_id, message_id, dedupe_key, text, even_if_opted_out, content, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, now()) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
    [userId, messageId, opts.dedupeKey ?? `msg:${messageId}`, text, !!opts.evenIfOptedOut, opts.content ? JSON.stringify(opts.content) : null],
  );
  if (job) await attempt(job.id);
}

async function attempt(jobId: number): Promise<void> {
  const j = await one<{
    id: number;
    user_id: number;
    text: string;
    content: RichContent | null;
    attempts: number;
    even_if_opted_out: boolean;
    phone: string;
    opted_out: boolean;
  }>(
    `SELECT j.id, j.user_id, j.text, j.content, j.attempts, j.even_if_opted_out, u.phone, u.opted_out
     FROM message_jobs j JOIN users u ON u.id = j.user_id WHERE j.id = $1`,
    [jobId],
  );
  if (!j) return;
  // STOP after queueing suppresses anything not yet sent (except the STOP acknowledgement itself).
  if (j.opted_out && !j.even_if_opted_out) {
    await q(`UPDATE message_jobs SET status = 'suppressed' WHERE id = $1`, [jobId]);
    return;
  }
  if (!deliverer) return; // not connected yet; the retry loop picks it up
  // Claim it atomically: the ticker's retry loop and the first send must never both send the same message.
  const claimed = await one(`UPDATE message_jobs SET status = 'sending', attempts = attempts + 1 WHERE id = $1 AND status = 'pending' RETURNING id`, [jobId]);
  if (!claimed) return;
  try {
    await deliverer(j.phone, j.text, j.content ?? null);
    await q(`UPDATE message_jobs SET status = 'sent', sent_at = now(), error = NULL WHERE id = $1`, [jobId]);
  } catch (e) {
    // Sanitized: never store message text or credentials in the error.
    const error = (e instanceof Error ? e.message : String(e)).replaceAll(config.photonProjectSecret || '\u0000', '[redacted]').slice(0, 300);
    const failed = j.attempts + 1 >= MAX_ATTEMPTS;
    await q(`UPDATE message_jobs SET status = $2, error = $3 WHERE id = $1`, [jobId, failed ? 'failed' : 'pending', error]);
    await trace('job', jobId, { kind: 'delivery', userId: j.user_id, attempts: j.attempts + 1, error, gaveUp: failed });
  }
}

// At startup: a send interrupted by a crash may or may not have reached Photon. Don't retry it (that risks a
// duplicate); mark it for inspection instead.
export async function recoverInterrupted(): Promise<void> {
  await q(`UPDATE message_jobs SET status = 'failed', error = 'interrupted mid-send; not retried to avoid a duplicate' WHERE status = 'sending'`);
}

// Ticker: retry pending deliveries (not yet attempted, or failed with attempts left).
export async function retryPending(): Promise<number> {
  const jobs = await q<{ id: number }>(
    `SELECT id FROM message_jobs WHERE status = 'pending' AND attempts < $1 AND created_at > now() - make_interval(hours => $2) ORDER BY id LIMIT 50`,
    [MAX_ATTEMPTS, RETRY_WINDOW_H],
  );
  for (const j of jobs) await attempt(j.id);
  return jobs.length;
}
