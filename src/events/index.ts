// Events: HyDE target profile, hidden invite rounds, Rocchio drift, RSVPs, host controls, discover.
import { getUser, one, q, toVec } from '../db/index.ts';
import { now } from '../clock.ts';
import { embedOne } from '../llm/embed.ts';
import { registerJob, schedule } from '../jobs/index.ts';
import { send } from '../transport/index.ts';
import { trace } from '../trace.ts';
import { publish } from '../bus.ts';
import type { Attendee, EventRow, EventSummary, NewEvent, Plan, RsvpResponse, RsvpResult } from '../types.ts';
import * as copy from './copy.ts';
import { hydeProfile } from './hyde.ts';
import { recomputeEt } from './rocchio.ts';
import { goingCount, goingNames, loadEvent, rowToEvent, setStatus, toEventRow, userName, type EventFull } from './store.ts';
import { closeEvent, maybeEarlyWave, roundTimeout, runWave, triggerWaveNow } from './waves.ts';
import {
  addRequirement,
  eventTextRules,
  hardEligible,
  headsUpFor,
  headsUpOnJoin,
  publicLabels,
  screeningFor,
  validate,
} from '../requirements/index.ts';
import { matchingDeps } from './deps.ts';

export { setMatchingDeps } from './deps.ts';

registerJob('wave', runWave);
registerJob('close_event', closeEvent);

const eventCopy = async (ev: EventFull): Promise<copy.EventCopy> => ({
  title: ev.title,
  when: copy.fmtWhen(ev.startsAt, await now()),
  location: ev.location,
});

// HyDE → E0 = Et → save → schedule wave 1 now (+ close_event at startsAt).
// opts.quietFirstRound: the caller reports the first round itself (the agent's reply), so a thin first round
// doesn't also send the host a separate "pool is thin" text.
// opts.noInvites: listed for discover only, never pushed to anyone (imported campus events).
export async function createEvent(
  hostId: number,
  d: NewEvent,
  opts: { quietFirstRound?: boolean; noInvites?: boolean } = {},
): Promise<EventRow> {
  const t = await now();
  const capacity = Math.max(1, Math.floor(d.capacity || 1));
  // Reject bad requirements before anything exists (0 stands in for the event id they'll get).
  for (const spec of d.requirements ?? []) validate(spec, 0);
  const hyde = await hydeProfile({ ...d, capacity });
  const e0 = await embedOne(hyde.text);
  const r = await one(
    `INSERT INTO events (host_id, title, raw_description, starts_at, location, capacity, hyde_profile,
                         initial_embedding, current_embedding, next_wave_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $10, $9) RETURNING *`,
    [hostId, d.title, d.description, d.startsAt.toISOString(), d.location, capacity, hyde.text, toVec(e0), t.toISOString(), opts.noInvites ? null : t.toISOString()],
  );
  const ev = rowToEvent(r!);
  // Stored before the first round is scheduled, so even the first invites respect them.
  for (const spec of d.requirements ?? []) await addRequirement(hostId, spec, ev.id);
  if (!opts.noInvites) await schedule('wave', { eventId: ev.id, afterWave: 0, ...(opts.quietFirstRound ? { quietThin: true } : {}) }, t);
  await schedule('close_event', { eventId: ev.id }, ev.startsAt);
  await trace('hyde', ev.id, { title: ev.title, source: hyde.source, targetProfile: hyde.text, ...(hyde.error ? { error: hyde.error } : {}) });
  publish({ type: 'state' });
  return toEventRow(ev);
}

const accepting = (ev: EventFull, t: Date) => (ev.status === 'open' || ev.status === 'full') && t < ev.startsAt;

// A YES seat was given up (cancel, or a yes-er later declining). Tell the host, reopen, and refill.
async function releaseSeat(ev: EventFull, userId: number): Promise<void> {
  const going = await goingCount(ev.id);
  await send(ev.hostId, copy.hostGuestOut(copy.firstName(await userName(userId)), ev.title, going, ev.capacity));
  const wasFull = ev.status === 'full';
  if (wasFull) await setStatus(ev.id, 'open');
  const t = await now();
  if (t.getTime() >= ev.startsAt.getTime()) return;
  // Offer the seat to whoever got waitlisted first; otherwise go find someone new right away.
  const waiting = await q<{ user_id: number }>(
    `SELECT user_id FROM event_invites WHERE event_id = $1 AND status = 'waitlisted' ORDER BY responded_at, user_id`,
    [ev.id],
  );
  let wait: { user_id: number } | undefined;
  for (const w of waiting) if (await hardEligible(w.user_id, ev.id)) { wait = w; break; }
  const fresh = (await loadEvent(ev.id))!;
  if (wait) {
    await q(`UPDATE event_invites SET status = 'invited', invited_at = $3, responded_at = NULL WHERE event_id = $1 AND user_id = $2`, [
      ev.id,
      wait.user_id,
      t.toISOString(),
    ]);
    await send(wait.user_id, copy.guestSpotOpened(await eventCopy(ev)));
    if (wasFull) {
      // Recruiting had stopped; resume on the normal timer in case they don't answer.
      const next = new Date(t.getTime() + roundTimeout(ev.startsAt, t));
      await q('UPDATE events SET next_wave_at = $2 WHERE id = $1', [ev.id, next.toISOString()]);
      await schedule('wave', { eventId: ev.id, afterWave: fresh.waveNumber }, next);
    }
  } else if (wasFull || fresh.waveNumber > 0) {
    await triggerWaveNow(ev.id, fresh.waveNumber);
  }
}

// Guest replies to an invite. 'cancel' releases an accepted seat.
export async function respondToInvite(userId: number, eventId: number, response: RsvpResponse): Promise<RsvpResult> {
  const inv = await one<{ status: string }>('SELECT status FROM event_invites WHERE event_id = $1 AND user_id = $2', [eventId, userId]);
  const ev = await loadEvent(eventId);
  if (!inv || !ev) return { outcome: 'not_invited', detail: "i don't have an invite for you to that one" };
  const t = await now();
  const c = await eventCopy(ev);
  if (!accepting(ev, t)) return { outcome: 'closed', detail: copy.guestClosed(ev.title) };
  const ts = t.toISOString();
  const setInvite = (status: string) =>
    q('UPDATE event_invites SET status = $3, responded_at = $4 WHERE event_id = $1 AND user_id = $2', [eventId, userId, status, ts]);

  let result: RsvpResult;
  if (response === 'yes') {
    if (inv.status === 'yes') return { outcome: 'accepted', detail: copy.guestAlreadyIn(c) };
    // A hard rule (host block either way, "keep X off this one") wins over any invite, old or new.
    if (!(await hardEligible(userId, eventId))) {
      await setInvite('withdrawn');
      return { outcome: 'closed', detail: copy.guestClosed(ev.title) };
    }
    // Claim a seat in one statement: the capacity check and the write can't interleave with another RSVP.
    const claimed = await q(
      `UPDATE event_invites SET status = 'yes', responded_at = $3
       WHERE event_id = $1 AND user_id = $2
         AND (SELECT count(*) FROM event_invites WHERE event_id = $1 AND status = 'yes')
             < (SELECT capacity FROM events WHERE id = $1 AND status = 'open')
       RETURNING user_id`,
      [eventId, userId, ts],
    );
    const cur = (await loadEvent(eventId))!;
    if (!claimed.length) {
      await setInvite('waitlisted');
      result = { outcome: 'waitlisted', detail: copy.guestWaitlisted(ev.title) };
    } else {
      const nowGoing = await goingCount(eventId);
      // Only the RSVP that actually flips open → full tells the host they're full.
      const full =
        nowGoing >= cur.capacity &&
        (await q(`UPDATE events SET status = 'full' WHERE id = $1 AND status = 'open' RETURNING id`, [eventId])).length > 0;
      await send(ev.hostId, copy.hostGuestIn(copy.firstName(await userName(userId)), ev.title, nowGoing, cur.capacity, full));
      await recomputeEt(eventId);
      await schedule('evolve_profile', { userId, eventId }, t);
      const host = copy.firstName(await userName(ev.hostId));
      // Blocks don't keep people out of other hosts' events; they get a heads-up instead (both directions).
      const blocked = await headsUpOnJoin(userId, eventId);
      result = { outcome: 'accepted', detail: copy.guestAccepted(c, host) + copy.headsUp(blocked) };
    }
  } else if (response === 'cancel') {
    if (inv.status === 'yes') {
      await setInvite('cancelled');
      await recomputeEt(eventId);
      await releaseSeat(ev, userId);
      result = { outcome: 'cancelled', detail: copy.guestCancelled(ev.title) };
    } else if (inv.status === 'waitlisted') {
      await setInvite('cancelled');
      result = { outcome: 'cancelled', detail: copy.guestCancelled(ev.title) };
    } else {
      // Cancelling an invite they never accepted is just a (neutral) no.
      await setInvite('no_busy');
      result = { outcome: 'declined', detail: copy.guestDeclined(ev.title) };
    }
  } else {
    // no_busy: schedule conflict, no signal about fit. no_vibe: pushes Et away from them.
    const wasYes = inv.status === 'yes';
    await setInvite(response);
    if (response === 'no_vibe' || wasYes) await recomputeEt(eventId);
    if (wasYes) await releaseSeat(ev, userId);
    result = { outcome: 'declined', detail: copy.guestDeclined(ev.title) };
  }
  await maybeEarlyWave(eventId);
  publish({ type: 'state' });
  return result;
}

export type ManageAction = 'status' | 'add_spots' | 'cancel' | 'stop_inviting' | 'update_description';
// Host controls. Returns a short plain-text status for the agent to relay. Never mentions waves.
export async function manageEvent(hostId: number, eventId: number, action: ManageAction, n?: number, description?: string): Promise<string> {
  const ev = await loadEvent(eventId);
  if (!ev || ev.hostId !== hostId) return "i couldn't find that event under your name";
  const t = await now();
  const ts = t.toISOString();
  const going = await goingCount(eventId);
  const names = (await goingNames(eventId)).map(copy.firstName);
  const roster = names.length ? ` (${names.join(', ')})` : '';
  const started = t >= ev.startsAt;

  if (action === 'status') {
    const head = `${ev.title}: ${going}/${ev.capacity} going${roster}.`;
    if (ev.status === 'cancelled') return `${ev.title} is cancelled.`;
    if (ev.status === 'closed' || started) return `${head} it's already started — no more invites.`;
    if (ev.status === 'full') return `${head} you're full!`;
    return `${head} still finding people.`;
  }
  if (ev.status === 'cancelled' || ev.status === 'closed' || started)
    return `${ev.title} is ${ev.status === 'cancelled' ? 'cancelled' : 'already over'}, so i can't change it.`;

  if (action === 'add_spots') {
    const add = Math.max(1, Math.floor(n ?? 1));
    const capacity = ev.capacity + add;
    await q(`UPDATE events SET capacity = $2, status = 'open' WHERE id = $1`, [eventId, capacity]);
    await triggerWaveNow(eventId, ev.waveNumber);
    publish({ type: 'state' });
    return `done — ${ev.title} now has ${capacity} spots (${going} going). i'll find more people.`;
  }
  if (action === 'update_description') {
    // Who it's for lives in the description and its ideal-attendee profile (E0), so widening or narrowing
    // means regenerating both. Et re-anchors to the new E0; anyone not yet invited is eligible again.
    const text = (description ?? '').trim();
    if (!text) return 'what should the new description say?';
    const hyde = await hydeProfile({ title: ev.title, description: text, startsAt: ev.startsAt, location: ev.location, capacity: ev.capacity });
    const e0 = await embedOne(hyde.text);
    await q(
      `UPDATE events SET raw_description = $2, hyde_profile = $3, initial_embedding = $4, current_embedding = $4, thin_pool_notified = false WHERE id = $1`,
      [eventId, text, hyde.text, toVec(e0)],
    );
    await recomputeEt(eventId);
    await trace('hyde', eventId, { title: ev.title, source: hyde.source, targetProfile: hyde.text, update: true });
    if (ev.status === 'open') await triggerWaveNow(eventId, ev.waveNumber);
    publish({ type: 'state' });
    return `updated ${ev.title}. ${ev.status === 'open' ? "i'm reaching out to more people who fit now." : "it's full, so no new invites."}`;
  }
  if (action === 'stop_inviting') {
    await q(`UPDATE events SET capacity = $2, status = 'full', next_wave_at = NULL WHERE id = $1`, [eventId, going]);
    await q(`UPDATE event_invites SET status = 'expired', responded_at = $2 WHERE event_id = $1 AND status = 'invited'`, [eventId, ts]);
    publish({ type: 'state' });
    return `got it, no more invites for ${ev.title}. ${going} going${roster}.`;
  }
  // cancel
  await q(`UPDATE events SET status = 'cancelled', next_wave_at = NULL WHERE id = $1`, [eventId]);
  await q(`UPDATE event_invites SET status = 'expired', responded_at = $2 WHERE event_id = $1 AND status = 'invited'`, [eventId, ts]);
  const guests = await q<{ user_id: number }>(`SELECT user_id FROM event_invites WHERE event_id = $1 AND status = 'yes'`, [eventId]);
  const host = copy.firstName(await userName(hostId));
  const c = await eventCopy(ev);
  for (const g of guests) await send(g.user_id, copy.guestEventCancelled(host, c));
  publish({ type: 'state' });
  return guests.length
    ? `cancelled ${ev.title} and let the ${guests.length} ${guests.length === 1 ? 'person' : 'people'} going know.`
    : `cancelled ${ev.title}.`;
}

const SUMMARY_SQL = `
  SELECT e.id, e.title, e.raw_description, e.starts_at, e.location, e.capacity, e.status, h.name AS host_name,
         (SELECT count(*)::int FROM event_invites i WHERE i.event_id = e.id AND i.status = 'yes') AS going
  FROM events e JOIN users h ON h.id = e.host_id`;

function toSummary(r: Record<string, any>): EventSummary {
  return {
    id: r.id,
    title: r.title,
    description: r.raw_description,
    startsAt: new Date(r.starts_at).toISOString(),
    location: r.location,
    spotsLeft: Math.max(0, r.capacity - r.going),
    goingCount: r.going,
    hostName: copy.firstName(r.host_name),
    ...(r.fit != null ? { fit: Math.round(Number(r.fit) * 1000) / 1000 } : {}),
  };
}

const DISCOVER_SCAN = 12; // tune: nearest open events looked at before hard rules hide some
const DISCOVER_MAX = 3; // tune: events returned

// Pull path: open events with spots, ranked for this user (optionally by a free-text query). Up to 3.
export async function discoverEvents(userId: number, query?: string): Promise<EventSummary[]> {
  const t = (await now()).toISOString();
  const qv = query?.trim() ? await embedOne(query.trim()) : (await getUser(userId))?.embedding ?? null;
  const rows = await q(
    `SELECT * FROM (
       SELECT sm.*, ${qv ? '1 - (ev.current_embedding <=> $3)' : 'NULL'} AS fit
       FROM (${SUMMARY_SQL}
         WHERE e.status = 'open' AND e.starts_at > $1 AND e.host_id <> $2
           AND NOT EXISTS (SELECT 1 FROM event_invites x WHERE x.event_id = e.id AND x.user_id = $2 AND x.status = 'yes')
           -- demo and real users never meet: only events hosted by someone in the same pool
           AND h.seeded = (SELECT seeded FROM users WHERE id = $2)
       ) sm JOIN events ev ON ev.id = sm.id
     ) s WHERE s.going < s.capacity ORDER BY ${qv ? 's.fit DESC' : 's.starts_at'} LIMIT ${DISCOVER_SCAN}`,
    qv ? [t, userId, toVec(qv)] : [t, userId],
  );
  // Hard rules hide an event (a host who blocked them, or that they blocked; "keep X off this one"). Blocks with
  // guests don't hide it: the result carries a heads-up instead. Text rules show up as who it's for.
  const out: EventSummary[] = [];
  for (const r of rows) {
    if (out.length >= DISCOVER_MAX) break;
    if (!(await hardEligible(userId, r.id))) continue;
    const forWho = await publicLabels(r.id);
    const headsUp = await headsUpFor(userId, r.id);
    out.push({ ...toSummary(r), ...(forWho.length ? { forWho } : {}), ...(headsUp.length ? { headsUp } : {}) });
  }
  return out;
}

// Agent context helpers.
export async function openInvitesFor(userId: number): Promise<(EventSummary & { inviteStatus: string })[]> {
  const rows = await q(
    `SELECT s.*, i.status AS invite_status FROM (${SUMMARY_SQL}) s
     JOIN event_invites i ON i.event_id = s.id AND i.user_id = $1
     WHERE s.status IN ('open', 'full') AND s.starts_at > $2 AND i.status IN ('invited', 'yes', 'waitlisted')
     ORDER BY s.starts_at`,
    [userId, (await now()).toISOString()],
  );
  return Promise.all(
    rows.map(async (r) => {
      const headsUp = await headsUpFor(userId, r.id);
      return { ...toSummary(r), inviteStatus: r.invite_status, ...(headsUp.length ? { headsUp } : {}) };
    }),
  );
}

export async function hostedEventsFor(userId: number): Promise<(EventSummary & { status: string })[]> {
  const rows = await q(
    `SELECT * FROM (${SUMMARY_SQL} WHERE e.host_id = $1) s
     WHERE s.status IN ('open', 'full') OR s.starts_at > $2 ORDER BY s.starts_at`,
    [userId, (await now()).toISOString()],
  );
  return rows.map((r) => ({ ...toSummary(r), status: r.status }));
}

// Everyone going to an event, host first, then guests in the order they said yes.
export async function attendeesFor(eventId: number): Promise<Attendee[]> {
  const rows = await q<{ user_id: number; name: string | null; role: 'host' | 'guest'; joined_at: string | null; source: Attendee['source'] }>(
    `SELECT a.user_id, u.name, a.role, a.joined_at, a.source FROM event_attendees a JOIN users u ON u.id = a.user_id
     WHERE a.event_id = $1 ORDER BY a.role = 'guest', a.joined_at NULLS LAST, a.user_id`,
    [eventId],
  );
  return rows.map((r) => ({
    userId: r.user_id,
    name: r.name ?? '',
    role: r.role,
    joinedAt: r.joined_at ? new Date(r.joined_at).toISOString() : null,
    source: r.source,
  }));
}

// Upcoming events this user is going to (hosting or a confirmed guest), soonest first, with the roster.
export async function plansFor(userId: number): Promise<Plan[]> {
  const rows = await q(
    `SELECT s.*, a.role FROM (${SUMMARY_SQL}) s JOIN event_attendees a ON a.event_id = s.id AND a.user_id = $1
     WHERE s.status IN ('open', 'full') AND s.starts_at > $2 ORDER BY s.starts_at`,
    [userId, (await now()).toISOString()],
  );
  return Promise.all(
    rows.map(async (r) => {
      const headsUp = await headsUpFor(userId, r.id);
      return { ...toSummary(r), role: r.role, attendees: await attendeesFor(r.id), ...(headsUp.length ? { headsUp } : {}) };
    }),
  );
}

// Join an event the user found via discover (creates the invite row, then accepts).
export async function joinEvent(userId: number, eventId: number): Promise<RsvpResult> {
  const ev = await loadEvent(eventId);
  if (!ev) return { outcome: 'closed', detail: "i couldn't find that event" };
  if (ev.hostId === userId) return { outcome: 'closed', detail: "that's your own event — you're already going!" };
  if (!accepting(ev, await now()) || !(await hardEligible(userId, eventId)) || !(await samePool(userId, ev.hostId)))
    return { outcome: 'closed', detail: copy.guestClosed(ev.title) };
  // Self-serve joins still have to meet the host's 'must' text rules (judged once, then remembered).
  const unmet = await unmetRule(userId, ev);
  if (unmet) return { outcome: 'closed', detail: copy.guestNotForYou(ev.title, unmet) };
  await q(
    `INSERT INTO event_invites (event_id, user_id, wave, pitch, invited_at, source) VALUES ($1, $2, $3, 'joined via discover', $4, 'discover')
     ON CONFLICT (event_id, user_id) DO NOTHING`,
    [eventId, userId, ev.waveNumber, (await now()).toISOString()],
  );
  return respondToInvite(userId, eventId, 'yes');
}

// The first 'must' text rule this user doesn't meet for the event, or null. Uses earlier verdicts when there are
// any; otherwise asks the same judge the invite rounds use, with this user as the only candidate.
async function unmetRule(userId: number, ev: EventFull): Promise<string | null> {
  const rules = await eventTextRules(ev.id);
  const must = rules.filter((r) => r.strength === 'must');
  if (!must.length) return null;
  const context = `event:${ev.id}`;
  let verdicts = await screeningFor(context, userId);
  if (must.some((r) => !verdicts.has(r.id))) {
    const u = await getUser(userId);
    await matchingDeps().rerank({
      purpose: 'event',
      target: `${ev.title}\n${ev.rawDescription}\n\n${ev.hydeProfile}`,
      candidates: [{ userId, name: u?.name ?? '', profile: u?.canonicalProfile ?? '', similarity: 1 }],
      k: 1,
      refId: ev.id,
      rules,
      context,
    });
    verdicts = await screeningFor(context, userId);
  }
  return must.find((r) => verdicts.get(r.id) !== 'pass')?.criterion ?? null;
}

// Demo and real users never meet.
async function samePool(a: number, b: number): Promise<boolean> {
  const r = await q<{ seeded: boolean }>('SELECT DISTINCT seeded FROM users WHERE id = ANY($1::int[])', [[a, b]]);
  return r.length === 1;
}

// Used by the inspector/server: Et's drift from E0 without shipping vectors around.
export async function eventDrift(eventId: number): Promise<number | null> {
  const r = await one<{ c: number }>('SELECT 1 - (initial_embedding <=> current_embedding) AS c FROM events WHERE id = $1', [eventId]);
  return r ? Math.round(Number(r.c) * 1000) / 1000 : null;
}
