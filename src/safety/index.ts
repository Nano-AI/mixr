import { q } from '../db/index.ts';
import { now } from '../clock.ts';
import { publish } from '../bus.ts';
import { trace } from '../trace.ts';

// Hard exclusions ("don't invite nate", "never match me with my ex"). These are enforced in SQL before any
// ranking happens; the LLM never sees an excluded person, so it can't "forget" a request.

const pattern = (name: string): string => name.trim().toLowerCase().replace(/\s+/g, ' ');

// Record an exclusion and pull back any pending invites it now forbids. eventId = just that event; null = always.
// Deliberately silent toward the excluded person: they're never told, and nothing reveals whether a match existed.
export async function excludePerson(ownerId: number, name: string, eventId: number | null): Promise<{ withdrawn: number }> {
  const p = pattern(name);
  if (p.length < 2) throw new Error('name is too short');
  const t = (await now()).toISOString();
  const [{ id }] = await q<{ id: number }>(
    'INSERT INTO exclusions (owner_id, name_pattern, event_id, created_at) VALUES ($1, $2, $3, $4) RETURNING id',
    [ownerId, p, eventId, t],
  );
  // Pending (not yet answered or waitlisted) invites that would now put the pair together.
  const withdrawn = await q<{ event_id: number; user_id: number }>(
    `UPDATE event_invites i SET status = 'withdrawn', responded_at = $2
     WHERE i.status IN ('invited', 'waitlisted') AND EXISTS (
       SELECT 1 FROM exclusion_matches m JOIN events e ON e.starts_at > $2
       WHERE m.exclusion_id = $1 AND (
         -- the excluded person's invite to an event the owner hosts or is going to (or to the one event named)
         (i.user_id = m.user_id AND e.id = i.event_id AND (m.event_id = e.id OR (m.event_id IS NULL
            AND EXISTS (SELECT 1 FROM event_attendees a WHERE a.event_id = e.id AND a.user_id = m.owner_id))))
         -- the owner's own invite to an event the excluded person hosts or is going to (always-exclusions only)
         OR (m.event_id IS NULL AND i.user_id = m.owner_id AND e.id = i.event_id
            AND EXISTS (SELECT 1 FROM event_attendees a WHERE a.event_id = e.id AND a.user_id = m.user_id))))
     RETURNING i.event_id, i.user_id`,
    [id, t],
  );
  await trace('safety', ownerId, { exclusion: id, scope: eventId ? `event ${eventId}` : 'always', pattern: p, withdrawn });
  publish({ type: 'state' });
  return { withdrawn: withdrawn.length };
}

// Users who must not be recalled for something involving `people` (and, if given, this event). Recall drops them in SQL.
export async function shieldedIds(people: number[], eventId?: number | null): Promise<number[]> {
  const rows = await q<{ id: number }>(
    `SELECT b AS id FROM block_pairs WHERE a = ANY($1::int[])
     UNION
     SELECT user_id FROM exclusion_matches WHERE event_id = $2`,
    [people, eventId ?? null],
  );
  return rows.map((r) => r.id);
}

// May this user be on this event's roster? False if they're excluded from it, or blocked with anyone going.
export async function allowedAt(userId: number, eventId: number): Promise<boolean> {
  const rows = await q(
    `SELECT 1 FROM event_attendees a JOIN block_pairs bp ON bp.a = a.user_id AND bp.b = $1 WHERE a.event_id = $2
     UNION ALL
     SELECT 1 FROM exclusion_matches WHERE event_id = $2 AND user_id = $1
     LIMIT 1`,
    [userId, eventId],
  );
  return rows.length === 0;
}

export async function blockedBetween(a: number, b: number): Promise<boolean> {
  return (await q('SELECT 1 FROM block_pairs WHERE a = $1 AND b = $2 LIMIT 1', [a, b])).length > 0;
}
