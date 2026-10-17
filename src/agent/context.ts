import { getUser, q } from '../db/index.ts';
import { HOUR } from '../clock.ts';
import { history } from '../transport/index.ts';
import { hostedEventsFor, openInvitesFor } from '../events/index.ts';
import { pendingIntrosFor } from '../relay/index.ts';
import type { AgentInputItem } from '../llm/index.ts';
import type { User } from '../types.ts';
import { laHuman, laIso, laLong, TZ } from './time.ts';

const HISTORY_LIMIT = 20; // tune: messages of conversation replayed to the model each turn
const RECENT_WINDOW = 48 * HOUR; // tune: how long find_people / discover_events results stay usable by id

export const firstName = (name: string | null | undefined): string => (name ?? '').trim().split(/\s+/)[0] || 'someone';

// A module that is still a stub (or briefly broken) shouldn't take the whole conversation down.
async function safe<T>(fn: () => Promise<T[]>): Promise<T[]> {
  try {
    return await fn();
  } catch {
    return [];
  }
}

type Recent = {
  people: { user_id: number; name: string; reason: string }[];
  events: { event_id: number; title: string; when: string; location: string }[];
};

// What this agent showed the user in recent turns, so "yeah intro me to jordan" or "i'll join the second one"
// can be resolved to ids on a later turn. Read back from our own 'agent' traces.
async function recentResults(userId: number, now: Date): Promise<Recent> {
  const rows = await q<{ data: any }>(
    `SELECT data FROM traces WHERE kind = 'agent' AND ref_id = $1 AND sim_time >= $2 ORDER BY id DESC LIMIT 10`,
    [userId, new Date(now.getTime() - RECENT_WINDOW).toISOString()],
  );
  const people = new Map<number, Recent['people'][number]>();
  const events = new Map<number, Recent['events'][number]>();
  for (const r of rows) {
    for (const c of (r.data?.toolCalls ?? []) as { name: string; result: any }[]) {
      if (c.name === 'find_people') for (const m of c.result?.matches ?? []) if (!people.has(m.user_id)) people.set(m.user_id, m);
      if (c.name === 'discover_events') for (const e of c.result?.events ?? []) if (!events.has(e.event_id)) events.set(e.event_id, e);
    }
  }
  // Drop people they've already been introduced to / asked about.
  if (people.size) {
    const taken = await q<{ other: number }>(
      `SELECT CASE WHEN requester_id = $1 THEN target_id ELSE requester_id END AS other FROM intros WHERE requester_id = $1 OR target_id = $1`,
      [userId],
    );
    for (const t of taken) people.delete(t.other);
  }
  return { people: [...people.values()].slice(0, 6), events: [...events.values()].slice(0, 6) };
}

export async function contextBlock(user: User, now: Date): Promise<string> {
  const [invites, intros, hosted, recent] = await Promise.all([
    safe(() => openInvitesFor(user.id)),
    safe(() => pendingIntrosFor(user.id)),
    safe(() => hostedEventsFor(user.id)),
    recentResults(user.id, now),
  ]);

  const L: string[] = [];
  L.push('[context: rebuilt from the database every turn; the user cannot see this block]');
  L.push(`now: ${laLong(now)} (${TZ}) | iso ${laIso(now)}`);
  L.push('');
  L.push(`user: name=${user.name ?? '(unknown, ask)'} | state=${user.state}${user.state === 'onboarding' ? ' (new, no profile saved yet)' : ''}`);
  if (user.snoozedUntil && user.snoozedUntil > now) L.push(`snoozed: yes, paused until ${laHuman(user.snoozedUntil)} (no invites or intro suggestions until then)`);
  else L.push('snoozed: no');
  L.push(user.canonicalProfile ? `profile (internal format, paraphrase casually if you mention it):\n${user.canonicalProfile}` : 'profile: none yet');

  L.push('');
  if (invites.length) {
    L.push('invites to them (event_id for respond_to_invite):');
    for (const e of invites) {
      L.push(
        `- event_id ${e.id}: "${e.title}" on ${laHuman(e.startsAt)} at ${e.location} | host ${firstName(e.hostName)} | ${e.goingCount} going, ${e.spotsLeft} spot(s) left | their status: ${e.inviteStatus}`,
      );
      if (e.description) L.push(`  details: ${e.description}`);
    }
  } else L.push('invites to them: none open');

  L.push('');
  if (intros.length) {
    L.push('intro requests waiting on THEIR answer (intro_id for respond_to_intro):');
    for (const i of intros) {
      const req = await getUser(i.requesterId);
      L.push(`- intro_id ${i.id}: ${firstName(req?.name)} wants to connect | reason: ${i.reason}`);
    }
  } else L.push('intro requests waiting on them: none');

  L.push('');
  if (hosted.length) {
    L.push('events they host (event_id for manage_event):');
    for (const e of hosted) {
      L.push(`- event_id ${e.id}: "${e.title}" on ${laHuman(e.startsAt)} at ${e.location} | status ${e.status} | ${e.goingCount} going, ${e.spotsLeft} spot(s) left`);
    }
  } else L.push('events they host: none');

  if (recent.people.length) {
    L.push('');
    L.push('people you suggested to them recently (user_id for request_intro):');
    for (const p of recent.people) L.push(`- user_id ${p.user_id}: ${p.name} | ${p.reason}`);
  }
  if (recent.events.length) {
    L.push('');
    L.push('events you showed them recently via discover (event_id for join_event):');
    for (const e of recent.events) L.push(`- event_id ${e.event_id}: "${e.title}" ${e.when} at ${e.location}`);
  }
  return L.join('\n');
}

// Conversation (oldest first) followed by the fresh context block.
export async function buildInput(user: User, now: Date): Promise<AgentInputItem[]> {
  const msgs = await history(user.id, HISTORY_LIMIT);
  const items: AgentInputItem[] = msgs.map((m) => ({ role: m.direction === 'in' ? 'user' : 'assistant', content: m.text }));
  items.unshift({ role: 'developer', content: await contextBlock(user, now) });
  return items;
}
