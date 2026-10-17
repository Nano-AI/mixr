import { db } from '../db.ts';
import type { SendResult } from '../types.ts';

// T0 stub: records the job with dedupe and logs instead of delivering.
// Wayne replaces the body in W1 (transport + opt-out); the signature is the contract.
export async function sendMessage(userId: number, text: string, dedupeKey: string): Promise<SendResult> {
  const { changes } = db.prepare('INSERT INTO message_jobs (user_id, dedupe_key, text) VALUES (?, ?, ?) ON CONFLICT(dedupe_key) DO NOTHING').run(userId, dedupeKey, text);
  if (!changes) return 'duplicate';
  if (process.env.TRANSPORT === 'console' && process.env.DB_PATH !== ':memory:') console.log(`[send user=${userId}] ${text}`);
  db.prepare("UPDATE message_jobs SET status = 'sent', sent_at = datetime('now') WHERE dedupe_key = ?").run(dedupeKey);
  return 'sent';
}
