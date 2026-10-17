import { db, tx } from '../db.ts';
import { sendMessage } from '../messaging/send.ts';
import { PLACES } from './places.ts';
import { planMeetups } from './planner.ts';
import { formatSlot } from './slots.ts';

export const REMIND_BEFORE_H = 2; // tune:
export const FEEDBACK_AFTER_H = 2; // tune:

const H = 3600_000;

type Row = { id: number; activity: string; slot: string; place_id: string };
type Msg = [userId: number, text: string, key: string];

const accepted = (id: number) =>
  (db.prepare("SELECT user_id FROM invitations WHERE meetup_id = ? AND state = 'accepted' ORDER BY user_id").all(id) as { user_id: number }[]).map((r) => r.user_id);

// Runs every 60s. State changes commit first; messages go out after, deduped by key, so re-running is safe.
export async function tick(now: Date, plan = planMeetups): Promise<void> {
  const iso = now.toISOString();
  const send = async (msgs: Msg[]) => { for (const [u, text, key] of msgs) await sendMessage(u, text, key); };

  // 1. Expire proposals that missed their deadline.
  await send(tx(() => {
    const msgs: Msg[] = [];
    const late = db.prepare("SELECT id, activity, slot, place_id FROM meetups WHERE state = 'proposed' AND deadline < ?").all(iso) as Row[];
    for (const m of late) {
      for (const u of accepted(m.id)) msgs.push([u, `Not enough people said yes for ${m.activity}. I'll try again.`, `expire:${m.id}:${u}`]);
      db.prepare("UPDATE meetups SET state = 'expired' WHERE id = ?").run(m.id);
      db.prepare("UPDATE invitations SET state = 'expired' WHERE meetup_id = ? AND state = 'pending'").run(m.id);
    }
    return msgs;
  }));

  // 2. Remind confirmed meetups starting within REMIND_BEFORE_H. No state change; dedupe keys do the work.
  const soon = db.prepare("SELECT id, activity, slot, place_id FROM meetups WHERE state = 'confirmed' AND slot <= ? AND slot > ?")
    .all(new Date(now.getTime() + REMIND_BEFORE_H * H).toISOString(), iso) as Row[];
  for (const m of soon) {
    const spot = PLACES.find((p) => p.id === m.place_id)?.meetSpot ?? 'the meeting spot';
    const text = `Today ${formatSlot(m.slot)}: ${m.activity} at ${spot}. Still in? CANCEL ${m.id} if not. Anything you're hoping to talk about?`;
    await send(accepted(m.id).map((u): Msg => [u, text, `remind:${m.id}:${u}`]));
  }

  // 3. Mark done and ask for feedback.
  await send(tx(() => {
    const msgs: Msg[] = [];
    const over = db.prepare("SELECT id, activity, slot, place_id FROM meetups WHERE state = 'confirmed' AND slot <= ?")
      .all(new Date(now.getTime() - FEEDBACK_AFTER_H * H).toISOString()) as Row[];
    for (const m of over) {
      db.prepare("UPDATE meetups SET state = 'done' WHERE id = ?").run(m.id);
      for (const u of accepted(m.id)) {
        db.prepare('INSERT OR IGNORE INTO feedback (meetup_id, user_id) VALUES (?, ?)').run(m.id, u);
        msgs.push([u, `How was ${m.activity}? Reply WENT or MISSED, plus anything about the group.`, `feedback:${m.id}:${u}`]);
      }
    }
    return msgs;
  }));

  // 4. Plan new meetups.
  await plan(now);
}
