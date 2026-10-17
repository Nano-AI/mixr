import { one, q } from '../db/index.ts';
import { HOUR, MINUTE, now } from '../clock.ts';
import { schedule } from '../jobs/index.ts';
import { send } from '../transport/index.ts';
import { trace } from '../trace.ts';
import type { RecallHit } from '../types.ts';
import { shieldedIds } from '../safety/index.ts';
import { matchingDeps } from './deps.ts';
import { fmtWhen, hostThinPool, inviteText } from './copy.ts';
import { goingCount, loadEvent, loadVectors, pendingCount, setStatus, type EventFull } from './store.ts';

// Hidden invite rounds ("waves" internally, never in user-facing text). Each round invites roughly enough
// people to fill the remaining spots at the observed yes-rate, then waits a bit before the next round.

export const P_YES_DEFAULT = 0.35; // tune: assumed yes-rate before this event has enough responses
export const P_YES_MIN = 0.15; // tune: clamp on observed yes-rate
export const P_YES_MAX = 0.8; // tune
export const MIN_RESOLVED = 5; // tune: responses (incl. expired) needed before trusting the event's own yes-rate
export const WAVE_MIN = 3; // tune: smallest round
export const WAVE_MAX = 10; // tune: biggest round (don't blast half of campus)
export const RECALL_FIRST = 40; // tune: first round recalls on E0 only
export const RECALL_ET = 32; // tune: later rounds: recall on the drifted Et...
export const RECALL_E0 = 8; // tune: ...plus an exploration buffer on E0 so early RSVPs' clique doesn't lock the event in
export const CUTOFF = 1 * HOUR; // tune: no new invites this close to start
export const TIMEOUT_MIN = 15 * MINUTE; // tune: shortest wait between rounds
export const TIMEOUT_MAX = 6 * HOUR; // tune: longest wait between rounds
export const TIMEOUT_DIVISOR = 6; // tune: wait = time-to-start / 6, clamped

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

export const roundTimeout = (startsAt: Date, t: Date): number =>
  clamp((startsAt.getTime() - t.getTime()) / TIMEOUT_DIVISOR, TIMEOUT_MIN, TIMEOUT_MAX);

export async function yesRate(eventId: number): Promise<{ pYes: number; observed: boolean }> {
  const r = (await one<{ yes: number; resolved: number }>(
    `SELECT count(*) FILTER (WHERE status IN ('yes', 'waitlisted', 'cancelled'))::int AS yes,
            count(*) FILTER (WHERE status <> 'invited')::int AS resolved
     FROM event_invites WHERE event_id = $1`,
    [eventId],
  ))!;
  if (r.resolved < MIN_RESOLVED) return { pYes: P_YES_DEFAULT, observed: false };
  return { pYes: clamp(r.yes / r.resolved, P_YES_MIN, P_YES_MAX), observed: true };
}

export const roundSize = (spotsLeft: number, pYes: number): number => clamp(Math.ceil(spotsLeft / pYes), WAVE_MIN, WAVE_MAX);

// Queue the next round to run right now (dedupes against the scheduled one via afterWave).
export async function triggerWaveNow(eventId: number, afterWave: number): Promise<void> {
  const t = await now();
  await q('UPDATE events SET next_wave_at = $2 WHERE id = $1', [eventId, t.toISOString()]);
  await schedule('wave', { eventId, afterWave }, t);
}

// After an RSVP: if nobody is left to hear back from and there's still room, don't wait for the timer.
export async function maybeEarlyWave(eventId: number): Promise<void> {
  const ev = await loadEvent(eventId);
  if (!ev || ev.status !== 'open' || ev.waveNumber === 0) return;
  if ((await pendingCount(eventId)) > 0) return;
  if ((await goingCount(eventId)) >= ev.capacity) return;
  if ((await now()).getTime() >= ev.startsAt.getTime() - CUTOFF) return;
  await triggerWaveNow(eventId, ev.waveNumber);
}

type Sourced = RecallHit & { source: 'Et' | 'E0' };

type Shield = { people: number[]; eventId: number };

async function candidates(ev: EventFull, exclude: number[], shield: Shield): Promise<Sourced[]> {
  const { recall } = matchingDeps();
  const { e0, et } = await loadVectors(ev.id);
  if (ev.waveNumber === 0) {
    const hits = await recall(e0, { exclude, shield, limit: RECALL_FIRST, refId: ev.id, label: 'event E0' });
    return hits.map((h) => ({ ...h, source: 'E0' as const }));
  }
  const fromEt = await recall(et, { exclude, shield, limit: RECALL_ET, refId: ev.id, label: 'event Et' });
  const fromE0 = await recall(e0, { exclude, shield, limit: RECALL_E0, refId: ev.id, label: 'event E0 (exploration)' });
  const seen = new Set<number>();
  const out: Sourced[] = [];
  for (const [hits, source] of [[fromEt, 'Et'], [fromE0, 'E0']] as const)
    for (const h of hits) if (!seen.has(h.userId)) seen.add(h.userId), out.push({ ...h, source });
  return out;
}

const stop = async (ev: EventFull, reason: string, extra: Record<string, unknown> = {}) => {
  await q('UPDATE events SET next_wave_at = NULL WHERE id = $1', [ev.id]);
  await trace('wave', ev.id, { wave: ev.waveNumber, stopped: reason, ...extra });
};

// Job 'wave' {eventId, afterWave}.
export async function runWave(payload: { eventId: number; afterWave: number }): Promise<void> {
  const ev = await loadEvent(payload.eventId);
  // Stale or duplicate trigger (an early round already ran), or event no longer recruiting.
  if (!ev || ev.status !== 'open' || ev.waveNumber !== payload.afterWave) return;
  const t = await now();

  if (t.getTime() >= ev.startsAt.getTime() - CUTOFF) return stop(ev, 'cutoff');

  // Earlier rounds' non-responders quietly time out. Neutral: no Rocchio penalty.
  await q(
    `UPDATE event_invites SET status = 'expired', responded_at = $2 WHERE event_id = $1 AND status = 'invited'`,
    [ev.id, t.toISOString()],
  );

  const going = await goingCount(ev.id);
  const spotsLeft = ev.capacity - going;
  if (spotsLeft <= 0) {
    await setStatus(ev.id, 'full');
    return stop(ev, 'full');
  }

  const { pYes, observed } = await yesRate(ev.id);
  const n = roundSize(spotsLeft, pYes);

  const already = await q<{ user_id: number }>('SELECT user_id FROM event_invites WHERE event_id = $1', [ev.id]);
  const exclude = [ev.hostId, ...already.map((r) => r.user_id)];
  // Hard exclusions (blocks of anyone going, host included, plus "not this event") are dropped in recall, before
  // ranking, and checked again here so no recall implementation can leak an excluded person into a wave.
  const attendees = await q<{ user_id: number }>('SELECT user_id FROM event_attendees WHERE event_id = $1', [ev.id]);
  const shield = { people: attendees.map((r) => r.user_id), eventId: ev.id };
  const shielded = new Set(await shieldedIds(shield.people, ev.id));
  const pool = (await candidates(ev, exclude, shield)).filter((c) => !exclude.includes(c.userId) && !shielded.has(c.userId));
  const byId = new Map(pool.map((c) => [c.userId, c]));

  const raw = pool.length
    ? await matchingDeps().rerank({
        purpose: 'event',
        target: `${ev.title}\n${ev.rawDescription}\n\n${ev.hydeProfile}`,
        candidates: pool,
        k: n,
        refId: ev.id,
      })
    : [];
  const picked = new Set<number>();
  const picks = raw.filter((p) => byId.has(p.userId) && !picked.has(p.userId) && picked.add(p.userId)).slice(0, n);

  if (!picks.length) {
    if (!ev.thinPoolNotified) {
      await q('UPDATE events SET thin_pool_notified = true WHERE id = $1', [ev.id]);
      await send(ev.hostId, hostThinPool(going));
    }
    return stop(ev, 'thin_pool', { pool: pool.length, n, pYes });
  }

  const wave = ev.waveNumber + 1;
  const copy = { title: ev.title, when: fmtWhen(ev.startsAt, t), location: ev.location };
  const invited: { userId: number; name: string; pitch: string; source: 'Et' | 'E0' }[] = [];
  for (const p of picks) {
    const c = byId.get(p.userId)!;
    const pitch = p.pitch?.trim() || 'thought of you for this one.';
    const r = await q(
      `INSERT INTO event_invites (event_id, user_id, wave, pitch, invited_at) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (event_id, user_id) DO NOTHING RETURNING user_id`,
      [ev.id, p.userId, wave, pitch, t.toISOString()],
    );
    if (!r.length) continue;
    await send(p.userId, inviteText(pitch, copy, spotsLeft));
    invited.push({ userId: p.userId, name: c.name, pitch, source: c.source });
  }

  const next = new Date(t.getTime() + roundTimeout(ev.startsAt, t));
  await q('UPDATE events SET wave_number = $2, next_wave_at = $3 WHERE id = $1', [ev.id, wave, next.toISOString()]);
  await schedule('wave', { eventId: ev.id, afterWave: wave }, next);
  await trace('wave', ev.id, {
    wave,
    n,
    pYes: Math.round(pYes * 1000) / 1000,
    pYesObserved: observed,
    spotsLeft,
    going,
    pool: pool.length,
    nextAt: next.toISOString(),
    invited,
  });
}

// Job 'close_event' {eventId}: the event started. Stop recruiting; outstanding invites lapse.
export async function closeEvent(payload: { eventId: number }): Promise<void> {
  const ev = await loadEvent(payload.eventId);
  if (!ev) return;
  const t = (await now()).toISOString();
  if (ev.status === 'open' || ev.status === 'full') await setStatus(ev.id, 'closed');
  await q(`UPDATE event_invites SET status = 'expired', responded_at = $2 WHERE event_id = $1 AND status = 'invited'`, [ev.id, t]);
  await q('UPDATE events SET next_wave_at = NULL WHERE id = $1', [ev.id]);
}
