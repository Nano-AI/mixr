import { getUser, one, q } from '../db/index.ts';
import { now } from '../clock.ts';
import { buildProfile, editProfile } from '../profiles/index.ts';
import { createEvent, discoverEvents, joinEvent, manageEvent, respondToInvite, type ManageAction } from '../events/index.ts';
import { findPeople } from '../matching/index.ts';
import { pendingIntrosFor, requestIntro, respondToIntro } from '../relay/index.ts';
import type { AgentTool } from '../llm/index.ts';
import type { RsvpResponse, User } from '../types.ts';
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
    }),
    run: async (ctx, a) => {
      const u = await me(ctx);
      if (!u.name) throw new ToolError("ask for the host's first name first");
      const startsAt = parseIso(a.starts_at, 'starts_at');
      if (startsAt <= (await now())) throw new ToolError('starts_at is in the past. check the current time in the context block.');
      const e = await createEvent(u.id, {
        title: nonEmpty(a.title, 'title'),
        description: nonEmpty(a.description, 'description'),
        startsAt,
        location: nonEmpty(a.location, 'location'),
        capacity: posInt(a.capacity, 'capacity', MAX_CAPACITY),
      });
      return { ok: true, ...eventView(e), capacity: e.capacity, status: e.status };
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
      'Host controls for an event the user hosts. status = who is going so far; add_spots = raise capacity by n; cancel = cancel the event and tell guests; stop_inviting = close it at the current headcount.',
    parameters: obj({
      event_id: int('event_id of an event they host (see context).'),
      action: { type: 'string', enum: ['status', 'add_spots', 'cancel', 'stop_inviting'] },
      n: { type: ['integer', 'null'], description: 'Spots to add for add_spots, else null.' },
    }),
    run: async (ctx, a) => {
      const u = await me(ctx);
      const ev = await one<{ host_id: number }>('SELECT host_id FROM events WHERE id = $1', [a.event_id]);
      if (!ev || ev.host_id !== u.id) throw new ToolError(`they don't host event ${a.event_id}`);
      if (!['status', 'add_spots', 'cancel', 'stop_inviting'].includes(a.action)) throw new ToolError('unknown action');
      const n = a.action === 'add_spots' ? posInt(a.n, 'n', MAX_CAPACITY) : undefined;
      return { result: await manageEvent(u.id, a.event_id, a.action as ManageAction, n) };
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
