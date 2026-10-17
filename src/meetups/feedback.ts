import { db, tx } from '../db.ts';
import { sendMessage } from '../messaging/send.ts';

const K = 32; // tune: Elo step size
const COMMITMENT = 1200; // tune: fixed opponent rating

// ponytail: self-report only; peer-reported no-shows are the upgrade.
export function eloUpdate(r: number, attended: boolean): number {
  const e = 1 / (1 + 10 ** ((COMMITMENT - r) / 400));
  return Math.round(r + K * ((attended ? 1 : 0) - e));
}

// Answers the newest outstanding feedback request. False if there is none.
export async function recordFeedback(userId: number, attended: boolean, note: string): Promise<boolean> {
  const meetupId = tx(() => {
    const row = db.prepare(
      'SELECT meetup_id FROM feedback WHERE user_id = ? AND attended IS NULL ORDER BY created_at DESC, meetup_id DESC LIMIT 1',
    ).get(userId) as { meetup_id: number } | undefined;
    if (!row) return null;
    const { reliability } = db.prepare('SELECT reliability FROM users WHERE id = ?').get(userId) as { reliability: number };
    db.prepare('UPDATE feedback SET attended = ?, note = ? WHERE meetup_id = ? AND user_id = ?').run(attended ? 1 : 0, note, row.meetup_id, userId);
    db.prepare('UPDATE users SET reliability = ? WHERE id = ?').run(eloUpdate(reliability, attended), userId);
    return row.meetup_id;
  });
  if (meetupId === null) return false;
  await sendMessage(userId, "Thanks! I'll keep looking for your next one.", `feedback-thanks:${meetupId}:${userId}`);
  return true;
}
