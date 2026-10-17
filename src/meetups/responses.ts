import { db, tx, fromBlob, toBlob } from '../db.ts';
import { sendMessage } from '../messaging/send.ts';
import { findCandidates } from '../matching/candidates.ts';
import { cosine, mean, normalize } from '../matching/vectors.ts';
import { PLACES, findPlace } from './places.ts';
import { CLOSE_BEFORE_H, DEADLINE_H } from './proposals.ts';
import { formatSlot } from './slots.ts';
import type { Reply, ResponseResult } from '../types.ts';

const EVENT_BIAS = 0.5; // tune: weight of accepted members' interests vs the original seed

const H = 3600_000;
type Row = Record<string, any>;
type Msg = [userId: number, text: string, key: string];

const first = (name: string | null) => (name ?? 'Someone').split(' ')[0];
const placeOf = (id: string) => PLACES.find((p) => p.id === id)!;
const meetupRow = (id: number) => db.prepare('SELECT * FROM meetups WHERE id = ?').get(id) as Row;
const accepted = (id: number) =>
  db.prepare("SELECT u.id, u.name, i.place_suggestion FROM invitations i JOIN users u ON u.id = i.user_id WHERE i.meetup_id = ? AND i.state = 'accepted' ORDER BY i.responded_at, u.id").all(id) as Row[];

// Each accepted member's interest closest to the seed pulls the meetup embedding their way.
function rebias(m: Row, members: Row[]) {
  const seed = fromBlob(m.seed_embedding);
  const pick = db.prepare('SELECT embedding FROM interests WHERE user_id = ?');
  const near = members.flatMap((u) => {
    const vs = (pick.all(u.id) as Row[]).map((r) => fromBlob(r.embedding));
    return vs.length ? [vs.reduce((a, b) => (cosine(b, seed) > cosine(a, seed) ? b : a))] : [];
  });
  if (!near.length) return;
  const pull = mean(near);
  const e = normalize(seed.map((x, i) => (1 - EVENT_BIAS) * x + EVENT_BIAS * pull[i]));
  db.prepare('UPDATE meetups SET embedding = ? WHERE id = ?').run(toBlob(e), m.id);
}

// Most votes wins; a tie keeps the current place if tied, else the earliest suggestion.
function tallyPlace(m: Row, members: Row[]): string {
  const votes = new Map<string, number>();
  for (const u of members) if (u.place_suggestion) votes.set(u.place_suggestion, (votes.get(u.place_suggestion) ?? 0) + 1);
  const top = Math.max(0, ...votes.values());
  const tied = [...votes].filter(([, n]) => n === top).map(([id]) => id);
  return !tied.length || tied.includes(m.place_id) ? m.place_id : tied[0];
}

const confirmText = (m: Row, members: Row[]) =>
  `Confirmed: ${m.activity}, ${formatSlot(m.slot)} at ${placeOf(m.place_id).name}. Meet at ${placeOf(m.place_id).meetSpot}. Going: ${members.map((u) => first(u.name)).join(', ')}. CANCEL ${m.id} if plans change.`;

export async function recordResponse(userId: number, proposalId: number, reply: Reply, now = new Date(), suggestion?: string): Promise<ResponseResult> {
  const msgs: Msg[] = [];
  let reopened = false;
  const out = tx((): ResponseResult => {
    const inv = db.prepare('SELECT * FROM invitations WHERE meetup_id = ? AND user_id = ?').get(proposalId, userId) as Row | undefined;
    if (!inv) return { outcome: 'not_invited' };
    const m = meetupRow(proposalId);
    const say = (text: string, tag: string) => msgs.push([userId, text, `reply:${tag}:${proposalId}:${userId}:${now.getTime()}`]);

    if (['expired', 'cancelled', 'done'].includes(m.state) || (m.state === 'proposed' && now.toISOString() > m.deadline)) {
      say("That one closed. I'll find you another.", 'closed');
      return { outcome: 'closed' };
    }
    const set = (state: string, place?: string | null) =>
      db.prepare('UPDATE invitations SET state = ?, responded_at = ?, place_suggestion = COALESCE(?, place_suggestion) WHERE meetup_id = ? AND user_id = ?').run(state, now.toISOString(), place ?? null, proposalId, userId);
    const name = first((db.prepare('SELECT name FROM users WHERE id = ?').get(userId) as Row).name);

    if (reply === 'cancel') {
      if (inv.state !== 'accepted') return { outcome: 'closed' };
      set('cancelled');
      const left = accepted(proposalId);
      for (const u of left) msgs.push([u.id, `${name} can't make it.`, `cancel:${proposalId}:${userId}:${u.id}`]);
      if (m.state === 'confirmed' && left.length < m.min_size) {
        if (now.getTime() < new Date(m.slot).getTime() - CLOSE_BEFORE_H * H) {
          reopened = true;
          db.prepare("UPDATE meetups SET state = 'proposed', deadline = ? WHERE id = ?").run(new Date(Math.min(now.getTime() + DEADLINE_H * H, new Date(m.slot).getTime() - CLOSE_BEFORE_H * H)).toISOString(), proposalId);
        } else {
          db.prepare("UPDATE meetups SET state = 'cancelled' WHERE id = ?").run(proposalId);
          for (const u of left) msgs.push([u.id, `Not enough people for ${m.activity} anymore, so it's off. I'll find you another.`, `off:${proposalId}:${u.id}`]);
        }
      }
      return { outcome: 'cancelled' };
    }

    if (inv.state !== 'pending') return { outcome: inv.state === 'accepted' && reply === 'yes' ? (m.state === 'confirmed' ? 'confirmed' : 'accepted') : 'closed' };
    if (reply === 'pass') {
      set('declined');
      say('No worries.', 'pass');
      return { outcome: 'declined' };
    }

    if (accepted(proposalId).length >= m.max_size) {
      set('full');
      say("It filled up, you're first in line next time.", 'full');
      return { outcome: 'full' };
    }
    const spot = m.state === 'proposed' && suggestion?.trim() ? findPlace(suggestion) : undefined;
    set('accepted', spot?.id);
    const members = accepted(proposalId);
    rebias(m, members);

    if (m.state === 'confirmed') {
      msgs.push([userId, confirmText(m, members), `confirm:${proposalId}:${userId}`]);
      for (const u of members) if (u.id !== userId) msgs.push([u.id, `${name} is joining too.`, `joined:${proposalId}:${userId}:${u.id}`]);
      return { outcome: 'confirmed' };
    }
    if (members.length >= m.min_size) {
      m.place_id = tallyPlace(m, members);
      db.prepare("UPDATE meetups SET state = 'confirmed', place_id = ? WHERE id = ?").run(m.place_id, proposalId);
      for (const u of members) msgs.push([u.id, confirmText(m, members), `confirm:${proposalId}:${u.id}`]);
      return { outcome: 'confirmed' };
    }
    const note = spot ? ` Noted your vote for ${spot.name}.` : suggestion?.trim() ? " I don't know that spot, so I'll stick to campus spots I know." : '';
    say(`You're in. I'll confirm once ${m.min_size - members.length} more say yes.${note}`, 'yes');
    return { outcome: 'accepted' };
  });
  // Sent after commit, never inside the transaction.
  for (const [u, text, key] of msgs) await sendMessage(u, text, key);
  if (reopened) await backfill(proposalId, now);
  return out;
}

// Invite the next best people until the meetup could confirm again.
export async function backfill(meetupId: number, now = new Date()): Promise<void> {
  const msgs: Msg[] = [];
  tx(() => {
    const m = meetupRow(meetupId);
    const need = m.min_size - accepted(meetupId).length;
    if (need <= 0) return;
    const invited = (db.prepare('SELECT user_id FROM invitations WHERE meetup_id = ?').all(meetupId) as Row[]).map((r) => r.user_id);
    const picks = findCandidates({ query: [{ label: m.activity, vector: fromBlob(m.embedding) }], kind: m.kind, slot: m.slot, excludeUserIds: invited, limit: need });
    const add = db.prepare('INSERT INTO invitations (meetup_id, user_id) VALUES (?, ?)');
    const text = `${m.activity}, ${formatSlot(m.slot)} at ${placeOf(m.place_id).name}. In? Reply YES ${meetupId} or PASS ${meetupId}. Rather meet somewhere else? Reply YES ${meetupId} + a spot.`;
    for (const c of picks) {
      add.run(meetupId, c.userId);
      msgs.push([c.userId, text, `invite:${meetupId}:${c.userId}`]);
    }
  });
  for (const [u, text, key] of msgs) await sendMessage(u, text, key);
}

// Meetup ids the user can answer: `pending` invitations for yes/pass, `accepted` for cancel.
export function openInvitations(userId: number, reply: Reply): number[] {
  const state = reply === 'cancel' ? 'accepted' : 'pending';
  return (db.prepare('SELECT meetup_id FROM invitations WHERE user_id = ? AND state = ? ORDER BY meetup_id').all(userId, state) as Row[]).map((r) => r.meetup_id);
}
