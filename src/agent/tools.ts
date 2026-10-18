import { getUser, one, q } from '../db/index.ts';
import { now } from '../clock.ts';
import { buildProfile, editProfile } from '../profiles/index.ts';
import { runDue } from '../jobs/index.ts';
import { createEvent, discoverEvents, joinEvent, manageEvent, respondToInvite, type ManageAction } from '../events/index.ts';
import { findPeople } from '../matching/index.ts';
import { pendingIntrosFor, requestIntro, respondToIntro } from '../relay/index.ts';
import { addRequirement, blockedEitherWay, blockPerson, removeRequirement, RequirementError, unblockPerson, validate } from '../requirements/index.ts';
import type { AgentTool } from '../llm/index.ts';
import type { RequirementSpec, RsvpResponse, User } from '../types.ts';
import { firstName } from './context.ts';
import { laHuman } from './time.ts';

const MAX_CAPACITY = 100; // tune: largest guest count an SMS-created event may ask for
const MAX_SNOOZE_DAYS = 60; // tune: longest pause

// Thrown for bad input / permission problems. The message goes back to the model verbatim as {error}.
export class ToolError extends Error {}

type Ctx = { userId: number };
type Handler = (ctx: Ctx, args: any) => Promise<unknown>;
type ToolDef = AgentTool & { run: Handler };

// Strict-mode schema helper: every property required, no extras.
const obj = (properties: Record<string, unknown>) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const str = (description: string) => ({ type: 'string', description });
const nstr = (description: string) => ({ type: ['string', 'null'], description });
const int = (description: string) => ({ type: 'integer', description });

// A special request, as the agent passes it. person: keep someone off one event. text: who qualifies, judged only
// from what people wrote in their own profiles. Gender and protected traits are refused.
const requirementSchema = obj({
  kind: { type: 'string', enum: ['person', 'text'] },
  person: nstr('kind person: the name as the user said it ("sam lee"; a first name alone covers everyone with it). Else null.'),
  criterion: nstr(
    'kind text: who qualifies, about interests, skill, vibe, or communities people mention about themselves (e.g. "advanced tennis, 4.0+", "queer folks", "beginners welcome / new to climbing"). Never gender, race, religion, disability, nationality. Else null.',
  ),
  strength: { type: 'string', enum: ['must', 'prefer'], description: 'must = only people who meet it; prefer = "if possible"' },
  said: str("The user's words for this request, brief."),
});

function toSpec(a: any): RequirementSpec {
  if (a?.kind === 'person') return { kind: 'person', person: String(a.person ?? ''), strength: a.strength, said: String(a.said ?? '') };
  return { kind: 'text', criterion: String(a?.criterion ?? ''), strength: a?.strength, said: String(a?.said ?? '') };
}

// RequirementError carries an agent-facing message; surface it as a ToolError.
async function asTool<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof RequirementError) throw new ToolError(e.message);
    throw e;
  }
}

async function me(ctx: Ctx): Promise<User> {
  const u = await getUser(ctx.userId);
  if (!u) throw new ToolError('user not found');
  return u;
}

async function activeMe(ctx: Ctx): Promise<User> {
  const u = await me(ctx);
  if (u.state !== 'active') throw new ToolError('this user has no profile yet. finish onboarding with save_profile first.');
  return u;
}

const nonEmpty = (v: unknown, field: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw new ToolError(`${field} is required`);
  return v.trim();
};

const posInt = (v: unknown, field: string, max: number): number => {
  if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > max) throw new ToolError(`${field} must be a whole number from 1 to ${max}`);
  return v as number;
};

function parseIso(v: unknown, field: string): Date {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) || !/(Z|[+-]\d{2}:?\d{2})$/.test(v)) {
    throw new ToolError(`${field} must be an ISO 8601 datetime with a UTC offset, e.g. 2026-10-23T19:00:00-07:00`);
  }
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new ToolError(`${field} is not a valid datetime`);
  return d;
}

// Event titles/descriptions are shown to invitees. Keep other students' names and exclusion requests out of them.
async function assertShareable(hostId: number, text: string): Promise<void> {
  if (/\b(don'?t|do not|never|not|no)\s+(be\s+|get\s+)?(invit|includ|add|ask|tell)\w*/i.test(text) || /\b(exclude|keep\s+\w+\s+(off|out|away))\b/i.test(text)) {
    throw new ToolError('the description must not say who to keep out (guests can read it). put that in requirements (kind person) or use block_person, and leave it out of the text');
  }
  const named = await one<{ name: string }>(
    `SELECT name FROM users WHERE id <> $1 AND name LIKE '% %' AND position(lower(name) in lower($2)) > 0 LIMIT 1`,
    [hostId, text],
  );
  if (named) throw new ToolError("the title/description must not name other students (guests can read it). leave people's names out; to keep someone out use requirements (kind person) or block_person");
}

const eventView = (e: { id: number; title: string; startsAt: string | Date; location: string }) => ({
  event_id: e.id,
  title: e.title,
  when: laHuman(e.startsAt),
  location: e.location,
});

export const TOOLS: ToolDef[] = [
  {
    name: 'save_profile',
    description:
      'Create (or fully redo) the user profile from everything they have told you about themselves. Call once onboarding info is gathered. Consolidate ALL their interests, skill levels, vibe preferences and context from the whole conversation into braindump, in their own words.',
    parameters: obj({
      name: nstr("The user's first name if they gave it, else null."),
      braindump: str('Everything the user said about their interests, hobbies, skill levels, what they want to do and who they want to meet, consolidated.'),
    }),
    run: async (ctx, a) => {
      const u = await me(ctx);
      const braindump = nonEmpty(a.braindump, 'braindump');
      const name = typeof a.name === 'string' && a.name.trim() ? a.name.trim() : undefined;
      if (!name && !u.name) throw new ToolError('ask for their first name before saving the profile');
      const profile = await buildProfile(u.id, braindump, name);
      return { ok: true, name: name ?? u.name, profile };
    },
  },
  {
    name: 'edit_profile',
    description: 'Change an existing profile: add, remove or adjust an interest or skill level ("add bouldering", "drop tennis, hurt my wrist", "i\'m more intermediate at chess").',
    parameters: obj({ change: str('The requested change, stated plainly.') }),
    run: async (ctx, a) => {
      const u = await activeMe(ctx);
      const profile = await editProfile(u.id, nonEmpty(a.change, 'change'));
      return { ok: true, profile };
    },
  },
  {
    name: 'create_event',
    description:
      'Host a new event. Only call once you know what it is, when, where, and how many guests (not counting the host). After it is created, mixr starts inviting people who would be into it.',
    parameters: obj({
      title: str('Short event name, e.g. "Catan night" or "4.5 tennis doubles".'),
      description: str('What it is and who it is for, including skill level/vibe if relevant, in a sentence or two.'),
      starts_at: str('Start time as ISO 8601 with the America/Los_Angeles UTC offset, e.g. 2026-10-23T19:00:00-07:00. Resolve relative times against the current time in the context block.'),
      location: str('Where it happens.'),
      capacity: int('Number of guest spots, excluding the host.'),
      requirements: { type: 'array', items: requirementSchema, description: 'Special requests for who gets invited (empty array if none). Enforced by the system.' },
    }),
    run: async (ctx, a) => {
      const u = await me(ctx);
      if (!u.name) throw new ToolError("ask for the host's first name first");
      const startsAt = parseIso(a.starts_at, 'starts_at');
      if (startsAt <= (await now())) throw new ToolError('starts_at is in the past. check the current time in the context block.');
      const title = nonEmpty(a.title, 'title');
      const description = nonEmpty(a.description, 'description');
      await assertShareable(u.id, `${title}\n${description}`);
      const requirements = (Array.isArray(a.requirements) ? a.requirements : []).map(toSpec);
      for (const r of requirements) await asTool(() => validate(r, 0));
      const e = await createEvent(
        u.id,
        { requirements, title, description, startsAt, location: nonEmpty(a.location, 'location'), capacity: posInt(a.capacity, 'capacity', MAX_CAPACITY) },
        { quietFirstRound: true },
      );
      // Send the first round of invites now, so the reply can say honestly how it went.
      await runDue();
      const sent = await one<{ n: number }>(`SELECT count(*)::int AS n FROM event_invites WHERE event_id = $1`, [e.id]);
      const invitedNow = sent?.n ?? 0;
      return {
        ok: true,
        ...eventView(e),
        capacity: e.capacity,
        status: e.status,
        invited_now: invitedNow,
        first_round:
          invitedNow === 0
            ? 'nobody on mixr fits yet; mixr keeps an eye out as people join. offer to loosen it (e.g. open up the level or vibe) if that makes sense'
            : invitedNow < e.capacity
              ? 'fewer good fits than spots so far; mixr keeps inviting as replies come in. offer one way to widen it if it fits'
              : 'plenty of good fits; more rounds go out automatically as people reply',
      };
    },
  },
  {
    name: 'respond_to_invite',
    description:
      'Record the user\'s answer to an event invite. yes = they are in; no_busy = can\'t make it / schedule conflict; no_vibe = not interested / not their thing; cancel = backing out after saying yes.',
    parameters: obj({
      event_id: int('event_id from the invites in the context block.'),
      response: { type: 'string', enum: ['yes', 'no_busy', 'no_vibe', 'cancel'] },
    }),
    run: async (ctx, a) => {
      const u = await me(ctx);
      if (!['yes', 'no_busy', 'no_vibe', 'cancel'].includes(a.response)) throw new ToolError('response must be yes, no_busy, no_vibe or cancel');
      const inv = await one('SELECT status FROM event_invites WHERE event_id = $1 AND user_id = $2', [a.event_id, u.id]);
      if (!inv) throw new ToolError(`they have no invite to event ${a.event_id}`);
      return await respondToInvite(u.id, a.event_id, a.response as RsvpResponse);
    },
  },
  {
    name: 'manage_event',
    description:
      'Host controls for an event the user hosts. status = who is going so far; add_spots = raise capacity by n; update_description = change what it is / who it is for (e.g. open it up to more levels), which immediately reaches out to newly fitting people; cancel = cancel the event and tell guests; stop_inviting = close it at the current headcount.',
    parameters: obj({
      event_id: int('event_id of an event they host (see context).'),
      action: { type: 'string', enum: ['status', 'add_spots', 'update_description', 'cancel', 'stop_inviting'] },
      n: { type: ['integer', 'null'], description: 'Spots to add for add_spots, else null.' },
      description: nstr('For update_description: the full new description (what it is and who it is for). Else null.'),
    }),
    run: async (ctx, a) => {
      const u = await me(ctx);
      const ev = await one<{ host_id: number }>('SELECT host_id FROM events WHERE id = $1', [a.event_id]);
      if (!ev || ev.host_id !== u.id) throw new ToolError(`they don't host event ${a.event_id}`);
      if (!['status', 'add_spots', 'update_description', 'cancel', 'stop_inviting'].includes(a.action)) throw new ToolError('unknown action');
      const n = a.action === 'add_spots' ? posInt(a.n, 'n', MAX_CAPACITY) : undefined;
      let description: string | undefined;
      if (a.action === 'update_description') {
        description = nonEmpty(a.description, 'description');
        const ev = await one<{ title: string }>('SELECT title FROM events WHERE id = $1', [a.event_id]);
        await assertShareable(u.id, `${ev?.title ?? ''}\n${description}`);
      }
      const result = await manageEvent(u.id, a.event_id, a.action as ManageAction, n, description);
      if (a.action === 'update_description') await runDue(); // the new round goes out now, like on creation
      return { result };
    },
  },
  {
    name: 'discover_events',
    description:
      'Find open upcoming events the user could join, matching what they asked for ("anything climbing this weekend?", "pickup soccer or something"). Returns up to 3 nearest events with fit (0-1, how close each is to the request). Nearest is not the same as relevant: judge each by its title/description.',
    parameters: obj({ query: nstr('What they are looking for, or null to use their profile.') }),
    run: async (ctx, a) => {
      const u = await me(ctx);
      const query = typeof a.query === 'string' && a.query.trim() ? a.query.trim() : undefined;
      if (!query && u.state !== 'active') throw new ToolError('no profile yet: ask what they are looking for, or onboard them first');
      const events = await discoverEvents(u.id, query);
      return {
        events: events.map((e) => ({
          ...eventView(e),
          description: e.description,
          host: firstName(e.hostName),
          going: e.goingCount,
          spots_left: e.spotsLeft,
          fit: e.fit ?? null,
          for_who: e.forWho ?? [], // the host's requirements, safe to mention
          heads_up: e.headsUp ?? [], // people this user blocked who are going: mention before they join
        })),
      };
    },
  },
  {
    name: 'join_event',
    description: 'Sign the user up for an event they picked from discover_events results.',
    parameters: obj({ event_id: int('event_id from discover results.') }),
    run: async (ctx, a) => {
      const u = await me(ctx);
      const ev = await one<{ host_id: number }>('SELECT host_id FROM events WHERE id = $1', [a.event_id]);
      if (!ev) throw new ToolError(`no event ${a.event_id}`);
      if (ev.host_id === u.id) throw new ToolError('they are the host of that event');
      return await joinEvent(u.id, a.event_id);
    },
  },
  {
    name: 'find_people',
    description:
      'Search for people the user might want to meet, optionally for something specific ("someone to hit with at 4.5", "jazz people", "people who play pickup soccer"). Returns up to 3 matches with first names and why. Also use it to check whether anyone is into an activity before suggesting they host it.',
    parameters: obj({ request: nstr('What kind of person they want to meet, or null for general matches from their profile.') }),
    run: async (ctx, a) => {
      const u = await activeMe(ctx);
      const request = typeof a.request === 'string' && a.request.trim() ? a.request.trim() : undefined;
      const matches = await findPeople(u.id, request, 3);
      return { matches: matches.map((m) => ({ user_id: m.userId, name: firstName(m.name), reason: m.reason })) };
    },
  },
  {
    name: 'request_intro',
    description: 'Ask a matched person if they are open to connecting with the user. mixr texts them and reports back; numbers are only shared if they say yes.',
    parameters: obj({
      target_user_id: int('user_id of the person (from find_people results).'),
      reason: str('Why they should meet, phrased for the other person, e.g. "a 4.5 hitting partner for weekend doubles".'),
    }),
    run: async (ctx, a) => {
      const u = await activeMe(ctx);
      if (a.target_user_id === u.id) throw new ToolError("can't intro someone to themselves");
      const t = await getUser(a.target_user_id);
      if (!t || t.state !== 'active') throw new ToolError(`no active user ${a.target_user_id}; use a user_id from find_people`);
      const dup = await one(
        `SELECT id FROM intros WHERE status IN ('proposed', 'target_asked', 'connected')
           AND ((requester_id = $1 AND target_id = $2) OR (requester_id = $2 AND target_id = $1))`,
        [u.id, t.id],
      );
      if (dup) throw new ToolError(`there is already an intro between them and ${firstName(t.name)}`);
      if (await blockedEitherWay(u.id, t.id)) throw new ToolError("can't set up that intro. tell the user simply that it didn't work out and offer to look for someone else");
      const intro = await requestIntro(u.id, t.id, nonEmpty(a.reason, 'reason'));
      return { ok: true, intro_id: intro.id, status: intro.status, target: firstName(t.name) };
    },
  },
  {
    name: 'respond_to_intro',
    description: "Answer an intro request someone sent this user. accept=true shares numbers both ways; message is an optional note to pass on to the requester.",
    parameters: obj({
      intro_id: int('intro_id from the context block.'),
      accept: { type: 'boolean' },
      message: nstr('Short note to pass to the other person, or null.'),
    }),
    run: async (ctx, a) => {
      const u = await me(ctx);
      const pending = await pendingIntrosFor(u.id);
      if (!pending.some((i) => i.id === a.intro_id)) throw new ToolError(`intro ${a.intro_id} is not waiting on this user`);
      if (typeof a.accept !== 'boolean') throw new ToolError('accept must be true or false');
      const message = typeof a.message === 'string' && a.message.trim() ? a.message.trim() : undefined;
      const intro = await respondToIntro(u.id, a.intro_id, a.accept, message);
      return { ok: true, status: intro.status };
    },
  },
  {
    name: 'block_person',
    description:
      "Block someone the user doesn't want around (an ex, someone they don't like or feel unsafe with). Effects: they never get invited to (or see) events this user hosts and vice versa, people-matching never pairs them, and if they end up at the same event anyway this user gets a heads-up. The blocked person is never told. Returns heads_up: upcoming events where that person is already going alongside this user.",
    parameters: obj({ name: str('The person as the user named them, e.g. "nate sullivan". A first name alone blocks everyone with that first name.') }),
    run: async (ctx, a) => {
      const u = await me(ctx);
      const { headsUp } = await asTool(() => blockPerson(u.id, nonEmpty(a.name, 'name')));
      return {
        ok: true,
        heads_up: headsUp.map((h) => ({ event_id: h.eventId, title: h.title, when: laHuman(h.startsAt), name: h.name })),
        note: "confirm briefly; never say whether that person uses mixr unless it's in heads_up",
      };
    },
  },
  {
    name: 'unblock_person',
    description: 'Undo a block, using the same name they blocked (see their blocks in the context block).',
    parameters: obj({ name: str('The blocked name exactly as listed in the context block.') }),
    run: async (ctx, a) => {
      const u = await me(ctx);
      const n = await unblockPerson(u.id, nonEmpty(a.name, 'name'));
      if (!n) throw new ToolError('no active block with that name; check the blocks listed in the context block');
      return { ok: true };
    },
  },
  {
    name: 'add_requirement',
    description:
      'Add a special request. scope "event": who gets invited to an event this user hosts (kind person = keep someone off it; kind text = who qualifies). scope "standing": a lasting preference for who they get matched with when finding people (kind text only; use block_person to keep a person away everywhere). Enforced by the system, never by wording in a description.',
    parameters: obj({
      scope: { type: 'string', enum: ['event', 'standing'] },
      event_id: { type: ['integer', 'null'], description: 'For scope "event": an event this user hosts (see context). Else null.' },
      requirement: requirementSchema,
    }),
    run: async (ctx, a) => {
      const u = await me(ctx);
      let eventId: number | null = null;
      if (a.scope === 'event') {
        const ev = await one<{ host_id: number }>('SELECT host_id FROM events WHERE id = $1', [a.event_id]);
        if (!ev || ev.host_id !== u.id) throw new ToolError('scope "event" needs an event_id this user hosts');
        eventId = a.event_id;
      } else if (a.scope !== 'standing') throw new ToolError('scope must be event or standing');
      const r = await asTool(() => addRequirement(u.id, toSpec(a.requirement), eventId));
      return { ok: true, requirement_id: r.id };
    },
  },
  {
    name: 'remove_requirement',
    description: 'Drop a special request they set earlier (requirement_id from the context block).',
    parameters: obj({ requirement_id: int('requirement_id from the context block.') }),
    run: async (ctx, a) => {
      const u = await me(ctx);
      if (!(await removeRequirement(u.id, a.requirement_id))) throw new ToolError('no active requirement with that id for this user');
      return { ok: true };
    },
  },
  {
    name: 'snooze',
    description: 'Pause (or resume) invites and intro suggestions. until = when to start again; null resumes right away.',
    parameters: obj({ until: nstr('ISO 8601 datetime with UTC offset to pause until, or null to unpause now.') }),
    run: async (ctx, a) => {
      const u = await me(ctx);
      if (a.until === null || a.until === undefined) {
        await q('UPDATE users SET snoozed_until = NULL WHERE id = $1', [u.id]);
        return { ok: true, snoozed: false };
      }
      const until = parseIso(a.until, 'until');
      const t = await now();
      if (until <= t) throw new ToolError('until is in the past');
      if (until.getTime() - t.getTime() > MAX_SNOOZE_DAYS * 86_400_000) throw new ToolError(`max pause is ${MAX_SNOOZE_DAYS} days`);
      await q('UPDATE users SET snoozed_until = $1 WHERE id = $2', [until.toISOString(), u.id]);
      return { ok: true, snoozed_until: laHuman(until) };
    },
  },
];

const byName = new Map(TOOLS.map((t) => [t.name, t]));

export const agentTools = (): AgentTool[] => TOOLS.map(({ name, description, parameters }) => ({ name, description, parameters }));

// Never throws: problems come back as {error} so the model can recover (ask the user, pick another id...).
export async function runTool(userId: number, name: string, rawArgs: string): Promise<{ args: unknown; result: unknown }> {
  let args: unknown;
  try {
    args = JSON.parse(rawArgs || '{}');
  } catch {
    return { args: rawArgs, result: { error: 'arguments were not valid JSON' } };
  }
  const t = byName.get(name);
  if (!t) return { args, result: { error: `unknown tool '${name}'` } };
  try {
    return { args, result: (await t.run({ userId }, args)) ?? { ok: true } };
  } catch (e) {
    const msg = e instanceof ToolError ? e.message : `tool failed: ${e instanceof Error ? e.message : String(e)}`;
    return { args, result: { error: msg } };
  }
}
