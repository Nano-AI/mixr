import { db } from '../db.ts';
import type { Candidate, Criteria } from '../types.ts';

// T0 stub: every active user not excluded, score 1. John replaces the body in J3; the signature is the contract.
export function findCandidates(c: Criteria): Candidate[] {
  const exclude = new Set(c.excludeUserIds ?? []);
  const q = c.query[0] ?? { label: '', vector: new Float32Array(384) };
  const rows = db.prepare(
    `SELECT u.id, u.name FROM users u JOIN profiles p ON p.user_id = u.id
     WHERE u.opted_out = 0 AND u.step = 'active' AND p.confirmed = 1 ORDER BY u.id`,
  ).all() as { id: number; name: string | null }[];
  return rows
    .filter((r) => !exclude.has(r.id))
    .slice(0, c.limit ?? Infinity)
    .map((r) => ({ userId: r.id, name: r.name ?? '', score: 1, label: q.label, vector: q.vector, reason: 'mock' }));
}
