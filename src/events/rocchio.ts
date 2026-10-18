import { fromVec, q, toVec } from '../db/index.ts';
import { trace } from '../trace.ts';
import { add, cosine, mean, normalize, scale } from '../vec.ts';
import { loadVectors } from './store.ts';

// tune: Rocchio weights. Et stays anchored to the host's intent (E0) and drifts toward who actually says yes.
export const ROCCHIO_ALPHA = 0.7; // tune: weight on E0 (the anchor)
export const ROCCHIO_BETA = 0.25; // tune: pull toward mean of YES attendees
export const ROCCHIO_GAMMA = 0.05; // tune: push away from mean of "not my thing" declines

// Pure Rocchio: drops empty terms.
export function rocchio(e0: number[], yes: number[][], noVibe: number[][]): number[] {
  const terms = [scale(e0, ROCCHIO_ALPHA)];
  if (yes.length) terms.push(scale(mean(yes), ROCCHIO_BETA));
  if (noVibe.length) terms.push(scale(mean(noVibe), -ROCCHIO_GAMMA));
  return normalize(add(...terms));
}

// Recompute Et from scratch from the current RSVPs and persist it.
export async function recomputeEt(eventId: number): Promise<{ yes: number; noVibe: number; cosToE0: number }> {
  const { e0 } = await loadVectors(eventId);
  const rows = await q<{ status: string; e: string | null }>(
    `SELECT i.status, u.embedding::text AS e FROM event_invites i JOIN users u ON u.id = i.user_id
     WHERE i.event_id = $1 AND i.status IN ('yes', 'no_vibe') AND u.embedding IS NOT NULL`,
    [eventId],
  );
  const yes = rows.filter((r) => r.status === 'yes').map((r) => fromVec(r.e)!);
  const noVibe = rows.filter((r) => r.status === 'no_vibe').map((r) => fromVec(r.e)!);
  const et = rocchio(e0, yes, noVibe);
  await q('UPDATE events SET current_embedding = $2 WHERE id = $1', [eventId, toVec(et)]);
  const out = { yes: yes.length, noVibe: noVibe.length, cosToE0: Math.round(cosine(et, e0) * 1000) / 1000 };
  await trace('rocchio', eventId, out);
  return out;
}
