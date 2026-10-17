import { db } from '../db.ts';
import type { SendResult } from '../types.ts';
import { send } from './transport.ts';

type Job = { id: number; user_id: number; text: string; dedupe_key: string };
const inflight = new Set<number>();
async function deliver(job: Job): Promise<SendResult> {
  if (inflight.has(job.id)) return 'duplicate';
  const user = db
    .prepare('SELECT phone, opted_out FROM users WHERE id=?')
    .get(job.user_id);
  if (!user || (user.opted_out && !job.dedupe_key.startsWith('stop-ack:')))
    return 'opted_out';
  inflight.add(job.id);
  db.prepare('UPDATE message_jobs SET attempts=attempts+1 WHERE id=?').run(
    job.id,
  );
  try {
    await send(String(user.phone), job.text);
    db.prepare(
      "UPDATE message_jobs SET status='sent', sent_at=datetime('now'), error=NULL WHERE id=?",
    ).run(job.id);
    return 'sent';
  } catch {
    // Provider errors may embed credentials or message contents. Keep diagnostics bounded.
    db.prepare(
      "UPDATE message_jobs SET status='failed', error='Transport rejected or could not confirm delivery' WHERE id=?",
    ).run(job.id);
    console.error(`Delivery failed for message job ${job.id}`);
    return 'failed';
  } finally {
    inflight.delete(job.id);
  }
}

export async function sendMessage(
  userId: number,
  text: string,
  dedupeKey: string,
): Promise<SendResult> {
  const user = db.prepare('SELECT opted_out FROM users WHERE id=?').get(userId);
  if (!user) throw Error('Unknown message recipient');
  if (user.opted_out && !dedupeKey.startsWith('stop-ack:')) return 'opted_out';
  const inserted = db
    .prepare(
      'INSERT INTO message_jobs (user_id,text,dedupe_key) VALUES (?,?,?) ON CONFLICT(dedupe_key) DO NOTHING',
    )
    .run(userId, text, dedupeKey);
  if (!inserted.changes) return 'duplicate';
  return deliver({
    id: Number(inserted.lastInsertRowid),
    user_id: userId,
    text,
    dedupe_key: dedupeKey,
  });
}

export async function retryFailed(): Promise<number> {
  const jobs = db
    .prepare(
      "SELECT j.id,j.user_id,j.text,j.dedupe_key FROM message_jobs j JOIN users u ON u.id=j.user_id WHERE j.status IN ('pending','failed') AND j.attempts < 3 AND COALESCE(j.error,'') <> 'Suppressed after STOP' AND (u.opted_out=0 OR j.dedupe_key LIKE 'stop-ack:%') ORDER BY j.id LIMIT 100",
    )
    .all() as Job[];
  let sent = 0;
  for (const job of jobs) if ((await deliver(job)) === 'sent') sent++;
  return sent;
}
