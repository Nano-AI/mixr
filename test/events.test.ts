import { afterAll, afterEach, beforeEach, expect, test, vi } from 'vitest';
import { axis, fresh, makeUser, T0 } from './helpers.ts';
import { fromVec, one, q, toVec } from '../src/db/index.ts';
import { HOUR, MINUTE, now } from '../src/clock.ts';
import { advance, runDue } from '../src/jobs/index.ts';
import { fakeEmbed, setEmbedder } from '../src/llm/embed.ts';
import { cosine, normalize } from '../src/vec.ts';
import type { RecallHit, RerankPick } from '../src/types.ts';
import type { RecallOpts, RerankReq } from '../src/matching/index.ts';
import {
  createEvent,
  discoverEvents,
  hostedEventsFor,
  joinEvent,
  manageEvent,
  openInvitesFor,
  respondToInvite,
} from '../src/events/index.ts';
import { setMatchingDeps } from '../src/events/deps.ts';
import { rocchio } from '../src/events/rocchio.ts';
import { roundSize, runWave, yesRate } from '../src/events/waves.ts';
import { fmtWhen } from '../src/events/copy.ts';
import type { FakeLlm } from '../src/llm/index.ts';

// ---------- fakes ----------

// Recall done directly in pgvector with the spec's filters, so tests don't depend on the matching module.
const fakeRecall = vi.fn(async (v: number[], o: RecallOpts = {}): Promise<RecallHit[]> => {
  const rows = await q<{ id: number; name: string; canonical_profile: string; sim: number }>(
    `SELECT id, name, canonical_profile, 1 - (embedding <=> $1) AS sim FROM users
     WHERE state = 'active' AND embedding IS NOT NULL AND (snoozed_until IS NULL OR snoozed_until <= $2)
       AND NOT (id = ANY($3::int[]))
     ORDER BY embedding <=> $1 LIMIT $4`,
    [toVec(v), (await now()).toISOString(), o.exclude ?? [], o.limit ?? 40],
  );
  return rows.map((r) => ({ userId: r.id, name: r.name, profile: r.canonical_profile, similarity: Number(r.sim) }));
});

// "LLM" rerank: best similarity first, template pitch.
const fakeRerank = vi.fn(async (r: RerankReq): Promise<RerankPick[]> =>
  [...r.candidates]
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, r.k)
    .map((c) => ({ userId: c.userId, reason: 'fits', pitch: `hey ${c.name.split(" ")[0]}, thought of you.` })),
);

// Deterministic embeddings for event text: keyword → axis.
const TOPICS: [RegExp, number][] = [
  [/tennis/i, 0],
  [/catan/i, 1],
  [/chess/i, 2],
];
setEmbedder(async (texts) => {
  const fallback = await fakeEmbed(texts);
  return texts.map((t, i) => {
    const hit = TOPICS.find(([re]) => re.test(t));
    return hit ? axis(hit[1]) : fallback[i];
  });
});
afterAll(() => {
  setEmbedder(fakeEmbed);
  setMatchingDeps();
});

let fake: FakeLlm;
beforeEach(async () => {
  fake = await fresh();
  fakeRecall.mockClear();
  fakeRerank.mockClear();
  setMatchingDeps({ recall: fakeRecall, rerank: fakeRerank });
});

// No outbound text ever leaks the machinery.
afterEach(async () => {
  const msgs = await q<{ text: string }>(`SELECT text FROM messages WHERE direction = 'out'`);
  for (const m of msgs) expect(m.text).not.toMatch(/wave|vector|score|algorithm/i);
});

// ---------- helpers ----------

let noiseAxis = 500;
// Unit vector mostly along `main`, with a private noise axis so users differ.
const near = (main: number, noise = 0.1) => normalize(axis(main).map((x, j) => (j === noiseAxis ? noise : x)));
async function crowd(prefix: string, n: number, main: number, noise = 0.1): Promise<number[]> {
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    noiseAxis++;
    ids.push(await makeUser(`${prefix}${i} Lastname`, `Core Interests:\n[1] ${prefix} things.`, near(main, noise)));
  }
  return ids;
}

const FRI_7PM = new Date('2026-10-23T19:00:00-07:00');

async function hostAndEvent(opts: { capacity?: number; startsAt?: Date; title?: string } = {}) {
  const host = await makeUser('Jordan Host', 'Core Interests:\n[1] Hosting things.', axis(900));
  const ev = await createEvent(host, {
    title: opts.title ?? 'Tennis doubles',
    description: 'pretty competitive doubles at the IMA courts',
    startsAt: opts.startsAt ?? FRI_7PM,
    location: 'IMA courts',
    capacity: opts.capacity ?? 2,
  });
  return { host, ev };
}

const invites = (eventId: number) =>
  q<{ user_id: number; wave: number; status: string; pitch: string }>(
    'SELECT user_id, wave, status, pitch FROM event_invites WHERE event_id = $1 ORDER BY wave, user_id',
    [eventId],
  );
const byStatus = async (eventId: number, status: string) => (await invites(eventId)).filter((i) => i.status === status);
const eventRow = (id: number) =>
  one<{ status: string; capacity: number; wave_number: number; next_wave_at: string | null; thin_pool_notified: boolean }>(
    'SELECT status, capacity, wave_number, next_wave_at, thin_pool_notified FROM events WHERE id = $1',
    [id],
  ).then((r) => r!);
const vectors = async (id: number) => {
  const r = (await one<{ e0: string; et: string }>(
    'SELECT initial_embedding::text AS e0, current_embedding::text AS et FROM events WHERE id = $1',
    [id],
  ))!;
  return { e0: fromVec(r.e0)!, et: fromVec(r.et)! };
};
const textsTo = async (userId: number) =>
  (await q<{ text: string }>(`SELECT text FROM messages WHERE user_id = $1 AND direction = 'out' ORDER BY id`, [userId])).map((r) => r.text);
const traces = async (kind: string) =>
  (await q<{ data: any }>('SELECT data FROM traces WHERE kind = $1 ORDER BY id', [kind])).map((r) => r.data);
const pendingWaveJobs = (eventId: number) =>
  q<{ payload: any; run_at: string }>(
    `SELECT payload, run_at FROM jobs WHERE kind = 'wave' AND NOT done AND (payload->>'eventId')::int = $1 ORDER BY run_at`,
    [eventId],
  );

// ---------- createEvent / HyDE ----------

test('createEvent: HyDE fallback, E0 = Et, schedules first round now and close at start', async () => {
  const { ev } = await hostAndEvent();
  expect(ev.hydeProfile).toBe('Target Attendee:\n[1] Tennis doubles. pretty competitive doubles at the IMA courts');
  const { e0, et } = await vectors(ev.id);
  expect(cosine(e0, axis(0))).toBeCloseTo(1, 5);
  expect(et).toEqual(e0);
  const jobs = await q<{ kind: string; payload: any; run_at: string }>('SELECT kind, payload, run_at FROM jobs ORDER BY id');
  expect(jobs.map((j) => [j.kind, j.payload, new Date(j.run_at).getTime()])).toEqual([
    ['wave', { eventId: ev.id, afterWave: 0 }, T0.getTime()],
    ['close_event', { eventId: ev.id }, FRI_7PM.getTime()],
  ]);
  const [h] = await traces('hyde');
  expect(h.source).toBe('fallback');
});

test('createEvent: uses the hyde_profile LLM output when available, falls back when it throws', async () => {
  let req: any;
  fake.onJson('hyde_profile', (r) => {
    req = r;
    return { target_profile: 'Core Interests:\n[1] Competitive doubles tennis, USTA 4.0 to 5.0, high-pace rallies (Level: Advanced).' };
  });
  const { ev } = await hostAndEvent();
  expect(ev.hydeProfile).toContain('USTA 4.0 to 5.0');
  expect(req.schema.required).toEqual(['target_profile']);
  expect(req.schema.additionalProperties).toBe(false);
  expect(req.input).toContain('pretty competitive doubles');

  fake.onJson('hyde_profile', () => {
    throw new Error('boom');
  });
  const ev2 = await createEvent(ev.hostId, { title: 'Chess', description: 'blitz', startsAt: FRI_7PM, location: 'HUB', capacity: 3 });
  expect(ev2.hydeProfile).toBe('Target Attendee:\n[1] Chess. blitz');
  const hy = await traces('hyde');
  expect(hy.map((h) => h.source)).toEqual(['llm', 'fallback']);
});

// ---------- rounds ----------

test('first round invites clamp(ceil(cap/0.35),3,10) best matches from E0 and texts them', async () => {
  const tennis = await crowd('Tennis', 12, 0);
  const catan = await crowd('Catan', 5, 1);
  const { ev, host } = await hostAndEvent({ capacity: 2 });
  await runDue();

  const inv = await invites(ev.id);
  expect(inv).toHaveLength(6); // ceil(2 / 0.35) = 6
  expect(inv.every((i) => i.wave === 1 && i.status === 'invited')).toBe(true);
  expect(inv.every((i) => tennis.includes(i.user_id))).toBe(true);
  expect(inv.some((i) => i.user_id === host || catan.includes(i.user_id))).toBe(false);

  // Round 1 is a single E0 recall of 40.
  expect(fakeRecall).toHaveBeenCalledTimes(1);
  // Lexical side of recall gets the host's raw title + description, not the HyDE profile.
  expect(fakeRecall.mock.calls[0][1]).toMatchObject({ limit: 40, text: 'Tennis doubles\npretty competitive doubles at the IMA courts' });
  expect(fakeRerank.mock.calls[0][0]).toMatchObject({ purpose: 'event', k: 6 });
  expect(fakeRerank.mock.calls[0][0].target).toContain('Tennis doubles');

  const [text] = await textsTo(inv[0].user_id);
  expect(text).toMatch(/^hey Tennis\d+, thought of you\. Tennis doubles — Fri 7:00 PM at IMA courts\. 2 spots left, you down\?$/);
  expect(text).not.toContain('Lastname');

  const row = await eventRow(ev.id);
  expect(row.wave_number).toBe(1);
  // (Fri 7pm − Tue noon) / 6 ≈ 13h → clamped to 6h.
  expect(new Date(row.next_wave_at!).getTime()).toBe(T0.getTime() + 6 * HOUR);
  const jobs = await pendingWaveJobs(ev.id);
  expect(jobs).toHaveLength(1);
  expect(jobs[0].payload).toEqual({ eventId: ev.id, afterWave: 1 });
  expect(new Date(jobs[0].run_at).getTime()).toBe(T0.getTime() + 6 * HOUR);

  const [w] = await traces('wave');
  expect(w).toMatchObject({ wave: 1, n: 6, pYes: 0.35, spotsLeft: 2 });
  expect(w.invited).toHaveLength(6);
  expect(w.invited.every((x: any) => x.source === 'E0' && x.pitch && x.name)).toBe(true);
  expect(JSON.stringify(w).length).toBeLessThan(3000); // no raw vectors
});

test('round size clamps to [3, 10]', async () => {
  await crowd('Tennis', 15, 0);
  const a = await hostAndEvent({ capacity: 1 });
  const b = await createEvent(a.host, { title: 'Tennis singles', description: 'x', startsAt: FRI_7PM, location: 'IMA', capacity: 8 });
  await runDue();
  expect(await invites(a.ev.id)).toHaveLength(3); // ceil(1/.35)=3
  expect(await invites(b.id)).toHaveLength(10); // ceil(8/.35)=23 → 10
  expect(roundSize(1, 0.35)).toBe(3);
  expect(roundSize(2, 0.35)).toBe(6);
  expect(roundSize(100, 0.35)).toBe(10);
});

test('timeout between rounds is (start − now)/6 clamped to [15 min, 6 h]', async () => {
  await crowd('Tennis', 10, 0);
  const { ev: soon } = await hostAndEvent({ startsAt: new Date(T0.getTime() + 2 * HOUR) });
  const { ev: sooner } = await hostAndEvent({ startsAt: new Date(T0.getTime() + 80 * MINUTE), title: 'Tennis rally' });
  await runDue();
  expect(new Date((await eventRow(soon.id)).next_wave_at!).getTime()).toBe(T0.getTime() + 20 * MINUTE);
  expect(new Date((await eventRow(sooner.id)).next_wave_at!).getTime()).toBe(T0.getTime() + 15 * MINUTE);
});

test('yes-rate uses the event’s own history once 5+ responses are in', async () => {
  const users = await crowd('Tennis', 6, 0);
  const { ev } = await hostAndEvent({ capacity: 5 });
  expect(await yesRate(ev.id)).toEqual({ pYes: 0.35, observed: false });
  const statuses = ['yes', 'no_busy', 'no_vibe', 'expired', 'expired'];
  for (const [i, s] of statuses.entries())
    await q(`INSERT INTO event_invites (event_id, user_id, wave, pitch, status, invited_at) VALUES ($1,$2,1,'p',$3,$4)`, [ev.id, users[i], s, T0.toISOString()]);
  expect(await yesRate(ev.id)).toEqual({ pYes: 0.2, observed: true });
  await q(`UPDATE event_invites SET status = 'no_busy' WHERE event_id = $1 AND status = 'yes'`, [ev.id]);
  expect((await yesRate(ev.id)).pYes).toBe(0.15); // clamped up from 0
});

test('early next round when everyone in the current round has answered', async () => {
  await crowd('Tennis', 12, 0);
  const { ev } = await hostAndEvent({ capacity: 1 });
  await runDue();
  const first = await invites(ev.id);
  expect(first).toHaveLength(3);
  await respondToInvite(first[0].user_id, ev.id, 'no_busy');
  await respondToInvite(first[1].user_id, ev.id, 'no_vibe');
  expect((await eventRow(ev.id)).wave_number).toBe(1); // one still pending → wait
  await respondToInvite(first[2].user_id, ev.id, 'no_busy');
  await runDue();
  expect((await now()).getTime()).toBe(T0.getTime()); // didn't wait the 6h
  const row = await eventRow(ev.id);
  expect(row.wave_number).toBe(2);
  const all = await invites(ev.id);
  expect(all.filter((i) => i.wave === 2)).toHaveLength(3);
  expect(new Set(all.map((i) => i.user_id)).size).toBe(6); // nobody invited twice
});

test('a stale or duplicate round trigger is a no-op', async () => {
  await crowd('Tennis', 12, 0);
  const { ev } = await hostAndEvent({ capacity: 1 });
  await runDue();
  await runWave({ eventId: ev.id, afterWave: 0 }); // already ran
  expect(await invites(ev.id)).toHaveLength(3);
  expect((await eventRow(ev.id)).wave_number).toBe(1);

  // Early trigger runs round 2; the original 6h timer for afterWave 1 then does nothing.
  for (const i of await invites(ev.id)) await respondToInvite(i.user_id, ev.id, 'no_busy');
  await runDue();
  expect((await eventRow(ev.id)).wave_number).toBe(2);
  const timers = (await pendingWaveJobs(ev.id)).map((j) => j.payload.afterWave);
  expect(timers).toEqual([1, 2]);
  await runWave({ eventId: ev.id, afterWave: 1 });
  expect((await eventRow(ev.id)).wave_number).toBe(2);
  expect(await invites(ev.id)).toHaveLength(6);
});

test('non-responders expire neutrally when the next round runs', async () => {
  await crowd('Tennis', 12, 0);
  const { ev } = await hostAndEvent({ capacity: 1 });
  await runDue();
  await advance(6 * HOUR);
  const inv = await invites(ev.id);
  expect(inv.filter((i) => i.wave === 1).every((i) => i.status === 'expired')).toBe(true);
  expect(inv.filter((i) => i.wave === 2 && i.status === 'invited')).toHaveLength(3);
  const { e0, et } = await vectors(ev.id);
  expect(cosine(e0, et)).toBeCloseTo(1, 6); // no penalty
  expect(await traces('rocchio')).toHaveLength(0);
});

// ---------- RSVPs ----------

test('capacity is never exceeded; extras are waitlisted; host hears when full', async () => {
  await crowd('Tennis', 12, 0);
  const { ev, host } = await hostAndEvent({ capacity: 2 });
  await runDue();
  const inv = await invites(ev.id);
  expect(inv).toHaveLength(6);
  // Everyone says yes at once.
  const results = await Promise.all(inv.map((i) => respondToInvite(i.user_id, ev.id, 'yes')));
  expect(results.filter((r) => r.outcome === 'accepted')).toHaveLength(2);
  expect(results.filter((r) => r.outcome === 'waitlisted')).toHaveLength(4);
  expect(results.find((r) => r.outcome === 'waitlisted')!.detail).toMatch(/filled up/);
  const acc = results.find((r) => r.outcome === 'accepted')!;
  expect(acc.detail).toContain('Tennis doubles');
  expect(acc.detail).toContain('Fri 7:00 PM');
  expect(acc.detail).toContain('IMA courts');
  expect(await byStatus(ev.id, 'yes')).toHaveLength(2);
  expect((await eventRow(ev.id)).status).toBe('full');

  const hostTexts = await textsTo(host);
  expect(hostTexts.filter((t) => / is in for Tennis doubles \(\d\/2\)/.test(t))).toHaveLength(2);
  expect(hostTexts.filter((t) => /you're full/.test(t))).toHaveLength(1);
  expect(hostTexts.some((t) => t.includes('Lastname'))).toBe(false); // first names only

  // Later rounds see it's full and stop.
  await advance(6 * HOUR);
  expect(await invites(ev.id)).toHaveLength(6);
  // evolve_profile scheduled for each YES.
  const evo = await q<{ payload: any }>(`SELECT payload FROM jobs WHERE kind = 'evolve_profile'`);
  expect(evo.map((j) => j.payload.eventId)).toEqual([ev.id, ev.id]);
});

test('respondToInvite: not invited, closed after start', async () => {
  const [u] = await crowd('Tennis', 4, 0);
  const { ev } = await hostAndEvent({ capacity: 1, startsAt: new Date(T0.getTime() + 3 * HOUR) });
  expect((await respondToInvite(u, ev.id, 'yes')).outcome).toBe('not_invited');
  await runDue();
  const [first] = await invites(ev.id);
  await advance(4 * HOUR); // past start; close_event ran
  expect((await respondToInvite(first.user_id, ev.id, 'yes')).outcome).toBe('closed');
});

test('cancel reopens a full event and triggers a new round right away', async () => {
  await crowd('Tennis', 12, 0);
  const { ev, host } = await hostAndEvent({ capacity: 1 });
  await runDue();
  const [a, b, c] = await invites(ev.id);
  await respondToInvite(a.user_id, ev.id, 'yes');
  await respondToInvite(b.user_id, ev.id, 'no_busy');
  await respondToInvite(c.user_id, ev.id, 'no_busy');
  await runDue();
  expect((await eventRow(ev.id)).status).toBe('full');
  expect(await invites(ev.id)).toHaveLength(3);

  const r = await respondToInvite(a.user_id, ev.id, 'cancel');
  expect(r.outcome).toBe('cancelled');
  expect((await eventRow(ev.id)).status).toBe('open');
  expect((await textsTo(host)).at(-1)).toMatch(/can't make Tennis doubles anymore \(0\/1\)/);
  await runDue();
  expect((await now()).getTime()).toBe(T0.getTime());
  const inv = await invites(ev.id);
  expect(inv.filter((i) => i.wave === 2)).toHaveLength(3);
  expect(inv.find((i) => i.user_id === a.user_id)!.status).toBe('cancelled');
});

test('a freed seat goes to the waitlist first', async () => {
  await crowd('Tennis', 12, 0);
  const { ev } = await hostAndEvent({ capacity: 1 });
  await runDue();
  const [a, b] = await invites(ev.id);
  await respondToInvite(a.user_id, ev.id, 'yes');
  expect((await respondToInvite(b.user_id, ev.id, 'yes')).outcome).toBe('waitlisted');
  await respondToInvite(a.user_id, ev.id, 'cancel');
  expect((await textsTo(b.user_id)).at(-1)).toMatch(/spot opened up for Tennis doubles/);
  expect((await respondToInvite(b.user_id, ev.id, 'yes')).outcome).toBe('accepted');
  expect(await byStatus(ev.id, 'yes')).toHaveLength(1);
  expect((await eventRow(ev.id)).status).toBe('full');
});

test('no_busy leaves Et unchanged; no_vibe pushes Et away from the decliner', async () => {
  await crowd('Tennis', 12, 0);
  const { ev } = await hostAndEvent({ capacity: 3 });
  // Two off-topic users get invites (hand-inserted so their vectors differ from E0).
  const busy = await makeUser('Busy Person', 'Core Interests:\n[1] Busy.', normalize(axis(0).map((x, j) => (j === 7 ? 1 : x))));
  const meh = await makeUser('Meh Person', 'Core Interests:\n[1] Meh.', normalize(axis(0).map((x, j) => (j === 8 ? 1 : x))));
  for (const u of [busy, meh])
    await q(`INSERT INTO event_invites (event_id, user_id, wave, pitch, invited_at) VALUES ($1,$2,1,'p',$3)`, [ev.id, u, T0.toISOString()]);

  const before = (await vectors(ev.id)).et;
  expect((await respondToInvite(busy, ev.id, 'no_busy')).outcome).toBe('declined');
  expect((await vectors(ev.id)).et).toEqual(before);

  const mehVec = normalize(axis(0).map((x, j) => (j === 8 ? 1 : x)));
  await respondToInvite(meh, ev.id, 'no_vibe');
  const { e0, et } = await vectors(ev.id);
  expect(cosine(et, mehVec)).toBeLessThan(cosine(before, mehVec));
  expect(cosine(et, e0)).toBeLessThan(1);
  const [r] = await traces('rocchio');
  expect(r).toMatchObject({ yes: 0, noVibe: 1 });
  expect(r.cosToE0).toBeGreaterThan(0.95);
});

test('Rocchio stays anchored to E0 after several off-topic YESes', async () => {
  const offTopic = await crowd('Catan', 6, 1, 0.3);
  const { ev } = await hostAndEvent({ capacity: 10 });
  for (const u of offTopic) expect((await joinEvent(u, ev.id)).outcome).toBe('accepted');
  const { e0, et } = await vectors(ev.id);
  expect(cosine(et, e0)).toBeGreaterThanOrEqual(0.7);
  expect(cosine(et, axis(1))).toBeGreaterThan(0.1); // but it did drift toward who showed up
  const rs = await traces('rocchio');
  expect(rs).toHaveLength(6);
  expect(rs.at(-1)).toMatchObject({ yes: 6, noVibe: 0 });
  expect(rs.at(-1).cosToE0).toBeGreaterThanOrEqual(0.7);
  expect(String(rs.at(-1).cosToE0).length).toBeLessThanOrEqual(5); // rounded
});

test('rocchio() math drops empty terms', () => {
  const e0 = axis(0, 4);
  expect(rocchio(e0, [], [])).toEqual(e0);
  const r = rocchio(e0, [axis(1, 4)], [axis(2, 4)]);
  const raw = [0.7, 0.25, -0.05, 0];
  const n = Math.hypot(...raw);
  r.forEach((x, i) => expect(x).toBeCloseTo(raw[i] / n, 10));
});

// ---------- stop conditions ----------

test('no new invites within an hour of start', async () => {
  await crowd('Tennis', 15, 0);
  const { ev } = await hostAndEvent({ capacity: 1, startsAt: new Date(T0.getTime() + 70 * MINUTE) });
  await runDue();
  expect(await invites(ev.id)).toHaveLength(3);
  await advance(20 * MINUTE); // next round at +15m is inside the cutoff
  expect(await invites(ev.id)).toHaveLength(3);
  const row = await eventRow(ev.id);
  expect(row.wave_number).toBe(1);
  expect(row.next_wave_at).toBeNull();
  expect((await traces('wave')).at(-1)).toMatchObject({ stopped: 'cutoff' });
});

test('thin pool: host is told once, and only once', async () => {
  await crowd('Tennis', 2, 0);
  const { ev, host } = await hostAndEvent({ capacity: 5 });
  await runDue();
  const inv = await invites(ev.id);
  expect(inv).toHaveLength(2);
  await respondToInvite(inv[0].user_id, ev.id, 'yes');
  await respondToInvite(inv[1].user_id, ev.id, 'no_busy');
  await runDue(); // early round finds nobody
  expect((await eventRow(ev.id)).thin_pool_notified).toBe(true);
  await manageEvent(host, ev.id, 'add_spots', 2);
  await runDue(); // still nobody
  await advance(12 * HOUR);
  const thin = (await textsTo(host)).filter((t) => /pretty thin/.test(t));
  expect(thin).toEqual(['found 1 so far — the pool for this is pretty thin right now, i\'ll keep an eye out']);
});

test('later rounds union Et recall (32) with an E0 exploration buffer (8)', async () => {
  const onTopic = await crowd('Tennis', 10, 0, 0.1); // near E0
  await crowd('Catan', 40, 1, 0.5); // where Et drifted to
  const { ev } = await hostAndEvent({ capacity: 10 });
  // Pretend round 1 already happened and attendees dragged Et toward the Catan crowd.
  await q('UPDATE events SET wave_number = 1, current_embedding = $2 WHERE id = $1', [ev.id, toVec(axis(1))]);
  await runWave({ eventId: ev.id, afterWave: 1 });

  expect(fakeRecall.mock.calls.map((c) => c[1]!.limit)).toEqual([32, 8]);
  const [w] = await traces('wave');
  expect(w.wave).toBe(2);
  expect(w.invited).toHaveLength(10);
  const sources = w.invited.map((x: any) => x.source);
  expect(sources).toContain('E0');
  expect(sources).toContain('Et');
  const fromE0 = w.invited.filter((x: any) => x.source === 'E0').map((x: any) => x.userId);
  expect(fromE0.every((id: number) => onTopic.includes(id))).toBe(true);
  expect(fromE0.length).toBeLessThanOrEqual(8);
});

test('rerank picks with unknown or duplicate ids are ignored and capped at n', async () => {
  const users = await crowd('Tennis', 6, 0);
  setMatchingDeps({
    recall: fakeRecall,
    rerank: async () => [
      { userId: 99999, reason: '', pitch: 'x' },
      { userId: users[0], reason: '', pitch: 'yo.' },
      { userId: users[0], reason: '', pitch: 'yo again.' },
      ...users.slice(1).map((u) => ({ userId: u, reason: '', pitch: 'hi.' })),
    ],
  });
  const { ev } = await hostAndEvent({ capacity: 1 });
  await runDue();
  const inv = await invites(ev.id);
  expect(inv.map((i) => i.user_id)).toEqual(users.slice(0, 3));
});

test('close_event closes the event and expires pending invites', async () => {
  await crowd('Tennis', 6, 0);
  const { ev } = await hostAndEvent({ capacity: 1, startsAt: new Date(T0.getTime() + 3 * HOUR) });
  await runDue();
  await advance(3 * HOUR);
  expect((await eventRow(ev.id)).status).toBe('closed');
  const inv = await invites(ev.id);
  expect(inv.length).toBeGreaterThan(0);
  expect(inv.every((i) => i.status === 'expired')).toBe(true);
});

// ---------- discover / join / context ----------

test('discoverEvents ranks by fit and skips own, full, and past events', async () => {
  const me = await makeUser('Maya Lee', 'Core Interests:\n[1] Tennis.', near(0, 0.2));
  const other = await makeUser('Sam Host', 'x', axis(901));
  const mk = (title: string, startsAt = FRI_7PM, capacity = 3) =>
    createEvent(other, { title, description: 'come hang', startsAt, location: 'HUB', capacity });
  const catan = await mk('Catan night');
  const tennis = await mk('Tennis hit');
  const chess = await mk('Chess club');
  const full = await mk('Tennis ladder');
  await q(`UPDATE events SET status = 'full' WHERE id = $1`, [full.id]);
  const packed = await mk('Tennis drills', FRI_7PM, 1);
  const filler = await makeUser('Filler Person', 'x', axis(902));
  await joinEvent(filler, packed.id);
  await mk('Tennis yesterday', new Date(T0.getTime() - HOUR));
  await createEvent(me, { title: 'My tennis thing', description: 'x', startsAt: FRI_7PM, location: 'HUB', capacity: 3 });

  const mine = await discoverEvents(me);
  expect(mine).toHaveLength(3);
  expect(mine[0].id).toBe(tennis.id);
  expect(mine.map((e) => e.id).sort()).toEqual([catan.id, tennis.id, chess.id].sort());
  expect(mine[0]).toMatchObject({ title: 'Tennis hit', hostName: 'Sam', spotsLeft: 3, goingCount: 0, location: 'HUB' });
  expect(mine[0].startsAt).toBe(FRI_7PM.toISOString());

  const q1 = await discoverEvents(me, 'board games like catan');
  expect(q1[0].id).toBe(catan.id);

  // Once joined, it no longer shows up.
  await joinEvent(me, tennis.id);
  expect((await discoverEvents(me)).map((e) => e.id)).not.toContain(tennis.id);
});

test('joinEvent: inserts a discover invite then accepts; refuses own/closed', async () => {
  const me = await makeUser('Maya Lee', 'x', near(0));
  const { ev, host } = await hostAndEvent({ capacity: 2 });
  const r = await joinEvent(me, ev.id);
  expect(r.outcome).toBe('accepted');
  expect(r.detail).toMatch(/Tennis doubles.*Fri 7:00 PM.*IMA courts/);
  const [inv] = await invites(ev.id);
  expect(inv).toMatchObject({ user_id: me, status: 'yes', pitch: 'joined via discover' });
  expect((await joinEvent(host, ev.id)).outcome).toBe('closed');
  await manageEvent(host, ev.id, 'cancel');
  const late = await makeUser('Late Person', 'x', near(0));
  expect((await joinEvent(late, ev.id)).outcome).toBe('closed');
});

test('openInvitesFor and hostedEventsFor', async () => {
  await crowd('Tennis', 6, 0);
  const { ev, host } = await hostAndEvent({ capacity: 2 });
  await runDue();
  const [a, b] = await invites(ev.id);
  await respondToInvite(b.user_id, ev.id, 'yes');
  const open = await openInvitesFor(a.user_id);
  expect(open).toHaveLength(1);
  expect(open[0]).toMatchObject({ id: ev.id, title: 'Tennis doubles', inviteStatus: 'invited', spotsLeft: 1, goingCount: 1, hostName: 'Jordan' });
  expect((await openInvitesFor(b.user_id))[0].inviteStatus).toBe('yes');
  await respondToInvite(a.user_id, ev.id, 'no_busy');
  expect(await openInvitesFor(a.user_id)).toEqual([]);

  const hosted = await hostedEventsFor(host);
  expect(hosted).toHaveLength(1);
  expect(hosted[0]).toMatchObject({ id: ev.id, status: 'open', goingCount: 1, spotsLeft: 1 });
});

// ---------- host controls ----------

test('manageEvent: status, add_spots, stop_inviting, cancel', async () => {
  await crowd('Tennis', 12, 0);
  const { ev, host } = await hostAndEvent({ capacity: 2 });
  await runDue();
  const inv = await invites(ev.id);
  await respondToInvite(inv[0].user_id, ev.id, 'yes');

  expect(await manageEvent(host, ev.id, 'status')).toMatch(/^Tennis doubles: 1\/2 going \(Tennis\d+\)\. still finding people\.$/);
  expect(await manageEvent(inv[1].user_id, ev.id, 'status')).toMatch(/couldn't find/);

  await respondToInvite(inv[1].user_id, ev.id, 'yes');
  expect((await eventRow(ev.id)).status).toBe('full');
  expect(await manageEvent(host, ev.id, 'status')).toMatch(/2\/2 going.*you're full!/);

  // add_spots reopens and recruits right away.
  const before = (await invites(ev.id)).length;
  expect(await manageEvent(host, ev.id, 'add_spots', 2)).toMatch(/4 spots \(2 going\)/);
  let row = await eventRow(ev.id);
  expect(row).toMatchObject({ status: 'open', capacity: 4 });
  await runDue();
  expect((await now()).getTime()).toBe(T0.getTime());
  expect((await invites(ev.id)).length).toBeGreaterThan(before);

  // stop_inviting: capacity = going, full, pending lapse.
  expect(await manageEvent(host, ev.id, 'stop_inviting')).toMatch(/no more invites.*2 going/);
  row = await eventRow(ev.id);
  expect(row).toMatchObject({ status: 'full', capacity: 2 });
  expect(await byStatus(ev.id, 'invited')).toHaveLength(0);
  await advance(6 * HOUR);
  expect(await byStatus(ev.id, 'invited')).toHaveLength(0);

  // cancel: guests going get a heads-up.
  const going = (await byStatus(ev.id, 'yes')).map((i) => i.user_id);
  expect(await manageEvent(host, ev.id, 'cancel')).toMatch(/cancelled Tennis doubles and let the 2 people going know/);
  expect((await eventRow(ev.id)).status).toBe('cancelled');
  for (const g of going) expect((await textsTo(g)).at(-1)).toMatch(/Jordan cancelled Tennis doubles \(Fri 7:00 PM\)/);
  expect(await manageEvent(host, ev.id, 'status')).toBe('Tennis doubles is cancelled.');
  expect((await respondToInvite(going[0], ev.id, 'cancel')).outcome).toBe('closed');
});

test('times format in LA time like "Fri 7:00 PM"', () => {
  expect(fmtWhen(FRI_7PM, T0)).toBe('Fri 7:00 PM');
  expect(fmtWhen(new Date('2026-10-31T02:30:00Z'), T0)).toBe('Fri, Oct 30, 7:30 PM');
});
