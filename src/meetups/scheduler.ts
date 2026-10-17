import { db, tx } from '../db.ts';
import { sendMessage } from '../messaging/send.ts';
import { PLACES } from './places.ts';
import { planMeetups } from './planner.ts';
import { formatSlot } from './slots.ts';

export const REMIND_BEFORE_H = 2; // tune:
export const FEEDBACK_AFTER_H = 2; // tune:
export const RETRY_WINDOW_H = 24; // tune: how long after the slot unsent expire/feedback messages are retried

const H = 3600_000;

type Row = { id: number; activity: string; slot: string; place_id: string };
type Msg = [userId: number, text: string, key: string];

const accepted = (id: number) =>
  (db.prepare("SELECT user_id FROM invitations WHERE meetup_id = ? AND state = 'accepted' ORDER BY user_id").all(id) as { user_id: number }[]).map((r) => r.user_id);

// One failed send must not stop the rest; the next tick retries it via the durable scans below.
async function send(msgs: Msg[]): Promise<void> {
  for (const [u, text, key] of msgs) {
    try { await sendMessage(u, text, key); } catch (e) { console.error(`tick: send ${key} failed`, e); }
  }
}

// Runs every 60s. State changes commit first; messages are then derived from durable state and deduped by key,
// so a crash or failed send is retried on the next tick and re-running is safe.
export async function tick(now: Date, plan = planMeetups): Promise<void> {
  const iso = now.toISOString();
  const recent = new Date(now.getTime() - RETRY_WINDOW_H * H).toISOString();

  // 1. Expire proposals that missed their deadline, then (re)send to accepted invitees of recently expired ones.
  tx(() => {
    const late = db.prepare("SELECT id FROM meetups WHERE state = 'proposed' AND deadline < ?").all(iso) as { id: number }[];
    for (const { id } of late) {
      db.prepare("UPDATE meetups SET state = 'expired' WHERE id = ?").run(id);
      db.prepare("UPDATE invitations SET state = 'expired' WHERE meetup_id = ? AND state = 'pending'").run(id);
    }
  });
  const expired = db.prepare("SELECT id, activity, slot, place_id FROM meetups WHERE state = 'expired' AND slot > ?").all(recent) as Row[];
  for (const m of expired) {
    await send(accepted(m.id).map((u): Msg => [u, `Not enough people said yes for ${m.activity}. I'll try again.`, `expire:${m.id}:${u}`]));
  }

  // 2. Remind confirmed meetups starting within REMIND_BEFORE_H.
  const soon = db.prepare("SELECT id, activity, slot, place_id FROM meetups WHERE state = 'confirmed' AND slot <= ? AND slot > ?")
    .all(new Date(now.getTime() + REMIND_BEFORE_H * H).toISOString(), iso) as Row[];
  for (const m of soon) {
    const spot = PLACES.find((p) => p.id === m.place_id)?.meetSpot ?? 'the meeting spot';
    const text = `Today ${formatSlot(m.slot)}: ${m.activity} at ${spot}. Still in? CANCEL ${m.id} if not. Anything you're hoping to talk about?`;
    await send(accepted(m.id).map((u): Msg => [u, text, `remind:${m.id}:${u}`]));
  }

  // 3. Mark done and create feedback rows, then (re)send to every outstanding feedback row of recent done meetups.
  tx(() => {
    const over = db.prepare("SELECT id FROM meetups WHERE state = 'confirmed' AND slot <= ?")
      .all(new Date(now.getTime() - FEEDBACK_AFTER_H * H).toISOString()) as { id: number }[];
    for (const { id } of over) {
      db.prepare("UPDATE meetups SET state = 'done' WHERE id = ?").run(id);
      for (const u of accepted(id)) db.prepare('INSERT OR IGNORE INTO feedback (meetup_id, user_id) VALUES (?, ?)').run(id, u);
    }
  });
  const owed = db.prepare(
    `SELECT m.id, m.activity, f.user_id FROM feedback f JOIN meetups m ON m.id = f.meetup_id
     WHERE m.state = 'done' AND f.attended IS NULL AND m.slot > ? ORDER BY m.id, f.user_id`,
  ).all(recent) as { id: number; activity: string; user_id: number }[];
  await send(owed.map((r): Msg => [r.user_id, `How was ${r.activity}? Reply WENT or MISSED, plus anything about the group.`, `feedback:${r.id}:${r.user_id}`]));

  // 4. Plan new meetups.
  await plan(now);
}
