import { db, fromBlob } from '../db.ts';
import { findCandidates } from '../matching/candidates.ts';
import { cosine, mean } from '../matching/vectors.ts';
import { createProposal } from './proposals.ts';
import { upcomingSlots } from './slots.ts';
import type { Candidate, Category, Query } from '../types.ts';

export const GROUP_MIN_SIM = 0.5; // tune: candidate vs. running group centroid
const GROUP_MAX = 6;
const GROUP_MIN = 3;

type Interest = Query & { category: Category };

// Greedy pass over unbusy users, oldest first. Idempotent: invited users count as busy.
export async function planMeetups(now: Date, find = findCandidates): Promise<number> {
  const busy = new Set((db.prepare(
    `SELECT DISTINCT i.user_id FROM invitations i JOIN meetups m ON m.id = i.meetup_id
     WHERE i.state IN ('pending','accepted') AND m.state IN ('proposed','confirmed') AND m.slot > ?`,
  ).all(now.toISOString()) as { user_id: number }[]).map((r) => r.user_id));
  const users = db.prepare(
    `SELECT u.id, u.mode FROM users u JOIN profiles p ON p.user_id = u.id
     WHERE u.step = 'active' AND u.opted_out = 0 AND p.confirmed = 1 ORDER BY u.id`,
  ).all() as { id: number; mode: 'pair' | 'group' | 'both' }[];
  const upcoming = upcomingSlots(now);
  let created = 0;

  for (const u of users) {
    if (busy.has(u.id)) continue;
    const have = new Set((db.prepare('SELECT slot FROM availability WHERE user_id = ?').all(u.id) as { slot: string }[]).map((r) => r.slot));
    const slots = upcoming.filter((s) => have.has(s));
    const interests = (db.prepare('SELECT label, category, embedding FROM interests WHERE user_id = ?').all(u.id) as { label: string; category: Category; embedding: Uint8Array }[])
      .map((r): Interest => ({ label: r.label, category: r.category, vector: fromBlob(r.embedding) }));
    const exclude = () => [u.id, ...busy];
    const propose = async (userIds: number[], d: { kind: 'pair' | 'group'; activity: string; category: Category; vector: Float32Array; slot: string; reason: string }) => {
      await createProposal({ ...d, userIds, visibility: d.kind === 'group' ? 'public' : 'private' }, now);
      for (const id of userIds) busy.add(id);
      created++;
    };

    if (u.mode !== 'pair') {
      for (const i of interests) {
        let best: { slot: string; cands: Candidate[]; total: number } | undefined;
        for (const slot of slots) {
          const cands = find({ query: [i], kind: 'group', slot, excludeUserIds: exclude() });
          const total = cands.reduce((s, c) => s + c.score, 0);
          if (!best || total > best.total) best = { slot, cands, total };
        }
        if (!best) continue;
        const group = [u.id];
        const vectors = [i.vector];
        let centroid = i.vector;
        for (const c of best.cands) {
          if (group.length >= GROUP_MAX) break;
          if (cosine(c.vector, centroid) < GROUP_MIN_SIM) continue;
          group.push(c.userId);
          vectors.push(c.vector);
          centroid = mean(vectors);
        }
        if (group.length >= GROUP_MIN) {
          await propose(group, { kind: 'group', activity: i.label, category: i.category, vector: i.vector, slot: best.slot, reason: `You're all into ${i.label}` });
          break;
        }
      }
      if (busy.has(u.id)) continue;
    }

    if (u.mode !== 'group') {
      let best: { c: Candidate; slot: string } | undefined;
      for (const slot of slots) {
        const [c] = find({ query: interests, kind: 'pair', slot, excludeUserIds: exclude() });
        if (c && (!best || c.score > best.c.score)) best = { c, slot };
      }
      if (best) {
        const { c, slot } = best;
        // Candidate carries no category; borrow it from u's closest interest.
        const category = interests.reduce((a, b) => (cosine(b.vector, c.vector) > cosine(a.vector, c.vector) ? b : a)).category;
        await propose([u.id, c.userId], { kind: 'pair', activity: c.label, category, vector: c.vector, slot, reason: c.reason });
      }
    }
  }
  return created;
}
