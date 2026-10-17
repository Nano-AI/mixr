import { db, tx, toBlob } from '../db.ts';
import { sendMessage } from '../messaging/send.ts';
import { pickPlace, placeOf } from './places.ts';
import { formatSlot, HOUR } from './slots.ts';
import type { Meetup, ProposalDetails } from '../types.ts';

export const DEADLINE_H = 6; // tune:
export const CLOSE_BEFORE_H = 2; // tune: replies close this long before the slot

const time = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

export async function createProposal(d: ProposalDetails, now = new Date()): Promise<Meetup> {
  const closeAt = new Date(d.slot).getTime() - CLOSE_BEFORE_H * HOUR;
  if (closeAt <= now.getTime()) throw new Error(`createProposal: slot ${d.slot} is less than ${CLOSE_BEFORE_H}h away`);
  const [minSize, maxSize] = d.kind === 'pair' ? [2, 2] : [3, 6];
  const deadline = new Date(Math.min(now.getTime() + DEADLINE_H * HOUR, closeAt)).toISOString();
  const placeId = pickPlace(d.category, d.slot);
  const vec = toBlob(d.vector);

  const id = tx(() => {
    const { lastInsertRowid } = db.prepare(
      `INSERT INTO meetups (kind, activity, category, place_id, slot, min_size, max_size, deadline, visibility, seed_embedding, embedding, host_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(d.kind, d.activity, d.category, placeId, d.slot, minSize, maxSize, deadline, d.visibility, vec, vec, d.hostUserId ?? null);
    const invite = db.prepare('INSERT INTO invitations (meetup_id, user_id) VALUES (?, ?)');
    for (const u of d.userIds) invite.run(lastInsertRowid, u);
    return Number(lastInsertRowid);
  });

  // Sent after commit, never inside the transaction.
  const place = placeOf(placeId).name;
  const when = formatSlot(d.slot);
  const reason = d.reason ?? d.activity;
  const suggest = `Rather meet somewhere else? Reply YES ${id} + a spot.`;
  const text = d.kind === 'pair'
    ? `Found someone: ${reason}. Coffee-style hang, ${when} at ${place}? YES ${id} / PASS ${id}. ${suggest}`
    : `${reason}. ${d.userIds.length} people want ${d.activity}, ${when} at ${place}. In? Reply YES ${id} or PASS ${id} by ${time(deadline)}. ${suggest}`;
  for (const u of d.userIds) await sendMessage(u, text, `invite:${id}:${u}`);

  return { id, kind: d.kind, activity: d.activity, category: d.category, placeId, slot: d.slot, minSize, maxSize, deadline, visibility: d.visibility, state: 'proposed' };
}
