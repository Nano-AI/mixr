import { db, fromBlob } from '../db.ts';
import { sendMessage } from '../messaging/send.ts';
import { cosine } from '../matching/vectors.ts';
import { placeOf } from './places.ts';
import { recordResponse } from './responses.ts';
import { formatSlot } from './slots.ts';
import type { ResponseResult } from '../types.ts';

const MIN_SIM = 0.45; // tune: keep in sync with matching/candidates.ts
const MAX_LISTED = 3; // tune:

type Row = Record<string, any>;

export async function listPublicEvents(userId: number, now = new Date(), dedupeKey = `events:${userId}:${now.getTime()}`): Promise<void> {
  const mine = (db.prepare('SELECT embedding FROM interests WHERE user_id = ?').all(userId) as Row[]).map((r) => fromBlob(r.embedding));
  const open = db.prepare(
    `SELECT m.*, (SELECT COUNT(*) FROM invitations i WHERE i.meetup_id = m.id AND i.state = 'accepted') AS n
     FROM meetups m
     WHERE m.visibility = 'public' AND m.state IN ('proposed', 'confirmed') AND m.slot > ?
       AND NOT EXISTS (SELECT 1 FROM invitations i WHERE i.meetup_id = m.id AND i.user_id = ?)
       AND m.slot NOT IN (SELECT b.slot FROM invitations i JOIN meetups b ON b.id = i.meetup_id
                          WHERE i.user_id = ? AND i.state IN ('pending', 'accepted') AND b.state IN ('proposed', 'confirmed'))`,
  ).all(now.toISOString(), userId, userId) as Row[];

  const top = open
    .map((m) => ({ m, sim: Math.max(-1, ...mine.map((v) => cosine(v, fromBlob(m.embedding)))) }))
    .filter(({ m, sim }) => m.n < m.max_size && sim >= MIN_SIM)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, MAX_LISTED)
    .map(({ m }) => m);

  const text = top.length
    ? [...top.map((m) => `${m.id}) ${m.activity}, ${formatSlot(m.slot)} at ${placeOf(m.place_id).name} (${m.n}/${m.max_size})`), `Reply JOIN ${top[0].id}`].join('\n')
    : "No open events match your interests right now. I'll text you when one comes up.";
  await sendMessage(userId, text, dedupeKey);
}

export async function joinEvent(userId: number, meetupId: number, now = new Date()): Promise<ResponseResult> {
  const m = db.prepare('SELECT visibility, state, slot FROM meetups WHERE id = ?').get(meetupId) as Row | undefined;
  if (!m || m.visibility !== 'public') return { outcome: 'not_invited' };
  if (!['proposed', 'confirmed'].includes(m.state) || now.getTime() >= new Date(m.slot).getTime()) {
    await sendMessage(userId, "That one closed. I'll find you another.", `reply:closed:${meetupId}:${userId}:${now.getTime()}`);
    return { outcome: 'closed' };
  }
  db.prepare('INSERT OR IGNORE INTO invitations (meetup_id, user_id) VALUES (?, ?)').run(meetupId, userId);
  return recordResponse(userId, meetupId, 'yes', now);
}
