import { one, q } from '../db/index.ts';
import { now } from '../clock.ts';
import { publish } from '../bus.ts';
import { trace } from '../trace.ts';
import { send } from '../transport/index.ts';
import type { Requirement, RequirementSpec, Strength } from '../types.ts';

// Who may be matched with whom, enforced by code at the cheapest reliable stage of the matching funnel:
//   stage 0 (SQL, before recall): blocks and event person rules -> excluded (or, for 'prefer', ranked lower)
//   stage 2 (rerank call):        text rules -> the LLM returns a per-candidate verdict, code drops the fails
// The LLM never enforces anything by omission; it only answers "does this candidate meet X?".

export class RequirementError extends Error {}

// Allowlist policy: hosts can ask about specific people and about what people wrote in their own profiles
// (interests, skill, vibe, communities they chose to mention, e.g. queer). Never gender, never protected traits.
const GENDER_WORDS = /\b(wom[ae]n|girls?|gals?|females?|lad(y|ies)|guys?|boys?|males?|men|dudes?|non-?binary|enby|gender)\b/i;
const PROTECTED =
  /\b(race|racial|ethnic\w*|religio\w*|disab\w*|nationality|immigrants?|citizenship)\b|\b(white|black|asian|hispanic|latin[oax]|jewish|muslim|christian|hindu|indian|arab)\s+(people|guys|girls|students|folks|ppl|ones)\b/i;

const pattern = (name: string): string => name.trim().toLowerCase().replace(/\s+/g, ' ');
const first = (name: string | null | undefined): string => (name ?? '').trim().split(/\s+/)[0] || 'someone';

// ---------- blocks ----------

export type HeadsUp = { eventId: number; title: string; startsAt: string; name: string };

// Block someone. Pending invites that would put one at the other's hosted event are withdrawn silently.
// Returns the upcoming events where the blocker will already see them, so the agent can give a heads-up.
export async function blockPerson(blockerId: number, name: string): Promise<{ headsUp: HeadsUp[] }> {
  const p = pattern(name);
  if (p.length < 2) throw new RequirementError('name is too short');
  const t = (await now()).toISOString();
  const [{ id }] = await q<{ id: number }>('INSERT INTO blocks (blocker_id, name_pattern, created_at) VALUES ($1, $2, $3) RETURNING id', [blockerId, p, t]);
  const withdrawn = await q<{ event_id: number; user_id: number }>(
    `UPDATE event_invites i SET status = 'withdrawn', responded_at = $2
     FROM events e, block_matches m
     WHERE m.block_id = $1 AND e.id = i.event_id AND e.starts_at > $2 AND i.status IN ('invited', 'waitlisted')
       AND ((e.host_id = m.blocker_id AND i.user_id = m.blocked_id) OR (e.host_id = m.blocked_id AND i.user_id = m.blocker_id))
     RETURNING i.event_id, i.user_id`,
    [id, t],
  );
  const headsUp = await q<{ event_id: number; title: string; starts_at: string; name: string }>(
    `SELECT e.id AS event_id, e.title, e.starts_at, u.name
     FROM block_matches m
     JOIN event_attendees theirs ON theirs.user_id = m.blocked_id
     JOIN event_attendees mine ON mine.event_id = theirs.event_id AND mine.user_id = m.blocker_id
     JOIN events e ON e.id = theirs.event_id AND e.starts_at > $2 AND e.status IN ('open', 'full')
     JOIN users u ON u.id = m.blocked_id
     WHERE m.block_id = $1 ORDER BY e.starts_at`,
    [id, t],
  );
  await trace('block', blockerId, { op: 'block', block: id, pattern: p, withdrawn, headsUp });
  publish({ type: 'state' });
  return { headsUp: headsUp.map((h) => ({ eventId: h.event_id, title: h.title, startsAt: new Date(h.starts_at).toISOString(), name: first(h.name) })) };
}

export async function unblockPerson(blockerId: number, name: string): Promise<number> {
  const r = await q('UPDATE blocks SET active = false WHERE blocker_id = $1 AND name_pattern = $2 AND active RETURNING id', [blockerId, pattern(name)]);
  if (r.length) {
    await trace('block', blockerId, { op: 'unblock', pattern: pattern(name) });
    publish({ type: 'state' });
  }
  return r.length;
}

export async function blocksOf(blockerId: number): Promise<string[]> {
  return (await q<{ name_pattern: string }>('SELECT name_pattern FROM blocks WHERE blocker_id = $1 AND active ORDER BY id', [blockerId])).map(
    (r) => r.name_pattern,
  );
}

export async function blockedEitherWay(a: number, b: number): Promise<boolean> {
  const r = await q(
    `SELECT 1 FROM block_matches WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1) LIMIT 1`,
    [a, b],
  );
  return r.length > 0;
}

// First names of people this user blocked who are going to the event (for invites, discover, "who's going").
export async function headsUpFor(userId: number, eventId: number): Promise<string[]> {
  const rows = await q<{ name: string | null }>(
    `SELECT u.name FROM event_attendees a JOIN block_matches m ON m.blocked_id = a.user_id AND m.blocker_id = $1
     JOIN users u ON u.id = a.user_id WHERE a.event_id = $2 ORDER BY a.joined_at NULLS FIRST`,
    [userId, eventId],
  );
  return [...new Set(rows.map((r) => first(r.name)))];
}

// `userId` just got a seat at `eventId`. Anyone going who blocked them gets a heads-up text; the names of
// people going whom *they* blocked come back so the confirmation can carry the heads-up.
export async function headsUpOnJoin(userId: number, eventId: number): Promise<string[]> {
  const ev = await one<{ title: string; starts_at: string }>('SELECT title, starts_at FROM events WHERE id = $1', [eventId]);
  const joiner = await one<{ name: string | null }>('SELECT name FROM users WHERE id = $1', [userId]);
  if (!ev) return [];
  const blockers = await q<{ user_id: number }>(
    `SELECT DISTINCT a.user_id FROM event_attendees a JOIN block_matches m ON m.blocker_id = a.user_id AND m.blocked_id = $1
     WHERE a.event_id = $2 AND a.user_id <> $1`,
    [userId, eventId],
  );
  for (const b of blockers) {
    await send(b.user_id, `heads up: ${first(joiner?.name)} just joined ${ev.title}. figured you'd want to know.`);
  }
  if (blockers.length) await trace('block', eventId, { op: 'heads_up', joiner: userId, notified: blockers.map((b) => b.user_id) });
  return headsUpFor(userId, eventId);
}

// ---------- requirements ----------

// Normalize and check a spec. Throws RequirementError with a message meant for the agent.
export function validate(spec: RequirementSpec, eventId: number | null): RequirementSpec {
  const said = (spec.said ?? '').trim() || '(no quote)';
  if (spec.strength !== 'must' && spec.strength !== 'prefer') throw new RequirementError('strength must be must or prefer');
  if (spec.kind === 'person') {
    if (eventId === null) throw new RequirementError('a person rule needs an event. to keep someone away everywhere, use block_person');
    const p = pattern(spec.person ?? '');
    if (p.length < 2) throw new RequirementError('person needs a name');
    return { kind: 'person', person: p, strength: spec.strength, said };
  }
  if (spec.kind === 'text') {
    const c = (spec.criterion ?? '').trim();
    if (c.length < 3) throw new RequirementError('criterion is empty');
    if (GENDER_WORDS.test(c)) throw new RequirementError("mixr doesn't filter people by gender. drop that part (keep anything else, e.g. skill, vibe, queer-friendly)");
    if (PROTECTED.test(c)) throw new RequirementError("mixr doesn't filter people by race, religion, disability, nationality or similar traits. decline that part politely");
    return { kind: 'text', criterion: c, strength: spec.strength, said };
  }
  throw new RequirementError('kind must be person or text');
}

function rowToRequirement(r: Record<string, any>): Requirement {
  const base = { id: r.id, ownerId: r.owner_id, eventId: r.event_id, strength: r.strength as Strength, said: r.said };
  return r.kind === 'person' ? { ...base, kind: 'person', person: r.person_pattern } : { ...base, kind: 'text', criterion: r.criterion };
}

export async function addRequirement(ownerId: number, spec: RequirementSpec, eventId: number | null): Promise<Requirement> {
  const v = validate(spec, eventId);
  const t = (await now()).toISOString();
  const [row] = await q(
    `INSERT INTO requirements (owner_id, event_id, kind, person_pattern, criterion, strength, said, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [ownerId, eventId, v.kind, v.kind === 'person' ? v.person : null, v.kind === 'text' ? v.criterion : null, v.strength, v.said, t],
  );
  const req = rowToRequirement(row);
  // A 'must' person rule added after invites went out: pull back that person's pending invite, silently.
  const withdrawn =
    req.kind === 'person' && req.strength === 'must'
      ? await q(
          `UPDATE event_invites SET status = 'withdrawn', responded_at = $3
           WHERE event_id = $1 AND status IN ('invited', 'waitlisted') AND user_id IN (SELECT user_id FROM person_rule_matches WHERE requirement_id = $2)
           RETURNING user_id`,
          [eventId, req.id, t],
        )
      : [];
  await trace('requirement', eventId ?? ownerId, { op: 'add', requirement: req, withdrawn: withdrawn.length });
  publish({ type: 'state' });
  return req;
}

export async function removeRequirement(ownerId: number, id: number): Promise<boolean> {
  const r = await q('UPDATE requirements SET active = false WHERE id = $1 AND owner_id = $2 AND active RETURNING id', [id, ownerId]);
  if (r.length) {
    await trace('requirement', ownerId, { op: 'remove', id });
    publish({ type: 'state' });
  }
  return r.length > 0;
}

// Active requirements a user set (standing ones and those on their events), for their own context.
export async function requirementsOwnedBy(ownerId: number): Promise<Requirement[]> {
  return (await q('SELECT * FROM requirements WHERE owner_id = $1 AND active ORDER BY id', [ownerId])).map(rowToRequirement);
}

export async function eventRequirements(eventId: number): Promise<Requirement[]> {
  return (await q('SELECT * FROM requirements WHERE event_id = $1 AND active ORDER BY id', [eventId])).map(rowToRequirement);
}

// ---------- stage 0: hard filters, applied in SQL before recall ranks anyone ----------

export type HardFilter = {
  excludeIds: number[]; // never recalled
  avoidIds: number[]; // 'prefer' person rules: ranked lower
};

// Inviting people to an event: the host's person rules, blocks either way with the host, and anyone the judge
// already screened out on a 'must' text rule for this event. (Blocks with guests don't exclude: heads-up instead.)
export async function eventFilter(eventId: number): Promise<HardFilter> {
  const excluded = await q<{ id: number }>(
    `SELECT user_id AS id FROM person_rule_matches WHERE event_id = $1 AND strength = 'must'
     UNION SELECT m.blocked_id FROM events e JOIN block_matches m ON m.blocker_id = e.host_id WHERE e.id = $1
     UNION SELECT m.blocker_id FROM events e JOIN block_matches m ON m.blocked_id = e.host_id WHERE e.id = $1
     UNION SELECT s.user_id FROM screenings s JOIN requirements r ON r.id = s.requirement_id
           WHERE s.context = $2 AND r.active AND r.strength = 'must' AND s.verdict <> 'pass'`,
    [eventId, `event:${eventId}`],
  );
  const avoid = await q<{ id: number }>(`SELECT user_id AS id FROM person_rule_matches WHERE event_id = $1 AND strength = 'prefer'`, [eventId]);
  return { excludeIds: excluded.map((r) => r.id), avoidIds: avoid.map((r) => r.id) };
}

// A person search by `userId`: never anyone blocked either way, nor anyone already screened out on their
// standing 'must' text preferences.
export async function peopleFilter(userId: number): Promise<HardFilter> {
  const excluded = await q<{ id: number }>(
    `SELECT blocked_id AS id FROM block_matches WHERE blocker_id = $1
     UNION SELECT blocker_id FROM block_matches WHERE blocked_id = $1
     UNION SELECT s.user_id FROM screenings s JOIN requirements r ON r.id = s.requirement_id
           WHERE s.context = $2 AND r.active AND r.strength = 'must' AND s.verdict <> 'pass'`,
    [userId, `people:${userId}`],
  );
  return { excludeIds: excluded.map((r) => r.id), avoidIds: [] };
}

// Does this user pass an event's hard rules right now? (Cheap: no LLM.)
export async function hardEligible(userId: number, eventId: number): Promise<boolean> {
  return !(await eventFilter(eventId)).excludeIds.includes(userId);
}

// ---------- stage 2: text rules judged in the rerank call ----------

export type JudgeRule = { id: number; criterion: string; strength: Strength };
export type Verdict = 'pass' | 'fail' | 'unknown';

export async function eventTextRules(eventId: number): Promise<JudgeRule[]> {
  return (await eventRequirements(eventId)).flatMap((r) => (r.kind === 'text' ? [{ id: r.id, criterion: r.criterion, strength: r.strength }] : []));
}

export async function standingTextRules(userId: number): Promise<JudgeRule[]> {
  return (await requirementsOwnedBy(userId)).flatMap((r) =>
    r.kind === 'text' && r.eventId === null ? [{ id: r.id, criterion: r.criterion, strength: r.strength }] : [],
  );
}

export async function recordScreenings(context: string, rows: { userId: number; requirementId: number; verdict: Verdict; reason?: string }[]): Promise<void> {
  const t = (await now()).toISOString();
  for (const r of rows) {
    await q(
      `INSERT INTO screenings (context, user_id, requirement_id, verdict, reason, created_at) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (context, user_id, requirement_id) DO UPDATE SET verdict = EXCLUDED.verdict, reason = EXCLUDED.reason, created_at = EXCLUDED.created_at`,
      [context, r.userId, r.requirementId, r.verdict, r.reason ?? null, t],
    );
  }
}

export async function screeningFor(context: string, userId: number): Promise<Map<number, Verdict>> {
  const rows = await q<{ requirement_id: number; verdict: Verdict }>('SELECT requirement_id, verdict FROM screenings WHERE context = $1 AND user_id = $2', [
    context,
    userId,
  ]);
  return new Map(rows.map((r) => [r.requirement_id, r.verdict]));
}

// Public-safe description of who an event is for (text rules only; person rules and the host's words never shown).
export async function publicLabels(eventId: number): Promise<string[]> {
  return (await eventTextRules(eventId)).map((r) => (r.strength === 'must' ? `for: ${r.criterion}` : `ideally: ${r.criterion}`));
}
