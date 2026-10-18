import { test, expect } from 'vitest';
import { fresh, makeUser, T0 } from './helpers.ts';
import { HOUR } from '../src/clock.ts';
import { getUser, getUserByPhone, q } from '../src/db/index.ts';
import { advance } from '../src/jobs/index.ts';
import { seed } from '../src/seed.ts';
import { attendeesFor, createEvent, discoverEvents, joinEvent, respondToInvite } from '../src/events/index.ts';
import { findPeople } from '../src/matching/index.ts';
import { addRequirement, blockPerson, unblockPerson, validate, RequirementError } from '../src/requirements/index.ts';
import { runTool } from '../src/agent/tools.ts';
import { contextBlock } from '../src/agent/context.ts';
import type { FakeLlm, JsonRequest } from '../src/llm/index.ts';
import '../src/profiles/index.ts';

// Real events + matching + requirements on fake embeddings. The fake LLM has no handlers unless a test adds one,
// so pipeline steps use their fallbacks.

const MAYA = '+12065550101';
const boardGames = {
  title: 'Board game night',
  description: 'casual board game night, catan, chess, whatever, all levels welcome',
  startsAt: new Date(T0.getTime() + 30 * HOUR),
  location: 'HUB',
  capacity: 5,
};

async function campus() {
  const fake = await fresh();
  await seed();
  const maya = (await getUserByPhone(MAYA))!.id;
  const nate = (await q<{ id: number }>(`SELECT id FROM users WHERE name = 'Nate Sullivan'`))[0].id;
  const owen = (await q<{ id: number }>(`SELECT id FROM users WHERE name = 'Owen Fitzgerald'`))[0].id;
  return { fake, maya, nate, owen };
}

const invitedTo = async (eventId: number) => await q<{ user_id: number; status: string }>('SELECT user_id, status FROM event_invites WHERE event_id = $1', [eventId]);
const textsTo = async (userId: number) =>
  (await q<{ text: string }>(`SELECT text FROM messages WHERE user_id = $1 AND direction = 'out' ORDER BY id`, [userId])).map((r) => r.text);

// A judge that decides like the real one is told to: pass only if the candidate's own profile says it.
function judge(fake: FakeLlm, says: (profile: string, criterion: string) => boolean, pick: (id: number) => boolean = () => true) {
  fake.onJson('rerank', (req: JsonRequest) => {
    const rules = [...req.input.matchAll(/requirement_id (\d+) \((must|prefer)\): (.+)/g)].map((m) => ({ id: Number(m[1]), criterion: m[3] }));
    const cands = req.input.split('--- user_id: ').slice(1).map((chunk) => ({ id: Number(chunk.split(' ')[0]), profile: chunk }));
    const k = Number(/K: (\d+)/.exec(req.input)![1]);
    const verdicts = cands.map((c) => ({ ...c, checks: rules.map((r) => ({ requirement_id: r.id, verdict: says(c.profile, r.criterion) ? 'pass' : 'fail', note: '' })) }));
    return {
      picks: verdicts.filter((c) => pick(c.id)).slice(0, k).map((c) => ({ user_id: c.id, reason: 'fits', pitch: 'thought of you', checks: c.checks })),
      screened_out: verdicts.flatMap((c) => c.checks.filter((x) => x.verdict === 'fail').map((x) => ({ user_id: c.id, requirement_id: x.requirement_id, note: 'no' }))),
    };
  });
}

// ---------- blocks ----------

test('a block keeps the blocked person out of every round of the blocker\'s event, before ranking', async () => {
  const { maya, nate } = await campus();
  // Sanity: without the block, Nate is a top pick for board games.
  const before = await createEvent(maya, boardGames);
  await advance(0);
  expect((await invitedTo(before.id)).map((r) => r.user_id)).toContain(nate);

  const { maya: m2, nate: n2 } = await campus();
  await blockPerson(m2, 'nate sullivan');
  const ev = await createEvent(m2, boardGames);
  await advance(0);
  for (let i = 0; i < 4; i++) await advance(6 * HOUR);
  expect((await invitedTo(ev.id)).map((r) => r.user_id)).not.toContain(n2);
  const recall = await q<{ data: any }>(`SELECT data FROM traces WHERE kind = 'recall' AND ref_id = $1 ORDER BY id LIMIT 1`, [ev.id]);
  expect(recall[0].data.hardFiltered.excluded).toBeGreaterThanOrEqual(1);
});

test("an LLM reranker that picks the blocked person anyway can't: he was never a candidate", async () => {
  const { fake, maya, nate } = await campus();
  fake.onJson('rerank', () => ({ picks: [{ user_id: nate, reason: 'loves catan', pitch: 'hi', checks: [] }], screened_out: [] }));
  await blockPerson(maya, 'nate sullivan');
  const ev = await createEvent(maya, boardGames);
  await advance(0);
  expect((await invitedTo(ev.id)).map((r) => r.user_id)).not.toContain(nate);
});

test('blocking after invites went out withdraws his pending invite silently; a later yes is refused', async () => {
  const { maya, nate } = await campus();
  const ev = await createEvent(maya, boardGames);
  await advance(0);
  const sent = (await textsTo(nate)).length;
  await blockPerson(maya, 'nate sullivan');
  expect((await invitedTo(ev.id)).find((r) => r.user_id === nate)?.status).toBe('withdrawn');
  expect((await textsTo(nate)).length).toBe(sent);
  expect((await respondToInvite(nate, ev.id, 'yes')).outcome).toBe('closed');
  expect((await attendeesFor(ev.id)).map((a) => a.userId)).not.toContain(nate);
});

test("hosting works both ways, matching both ways, intros refused; discover hides each other's hosted events", async () => {
  const { maya, nate } = await campus();
  await blockPerson(maya, 'nate sullivan');
  const mayas = await createEvent(maya, boardGames);
  const nates = await createEvent(nate, { ...boardGames, title: 'Catan + snacks', location: 'Odegaard' });
  await advance(0);
  expect((await invitedTo(nates.id)).map((r) => r.user_id)).not.toContain(maya);
  expect((await discoverEvents(nate, 'board games catan')).map((e) => e.id)).not.toContain(mayas.id);
  expect((await discoverEvents(maya, 'board games catan')).map((e) => e.id)).not.toContain(nates.id);
  expect((await joinEvent(nate, mayas.id)).outcome).toBe('closed');
  expect((await findPeople(nate, 'catan and board games', 10)).map((m) => m.userId)).not.toContain(maya);
  expect((await findPeople(maya, 'catan and board games', 10)).map((m) => m.userId)).not.toContain(nate);
  const intro = await runTool(nate, 'request_intro', JSON.stringify({ target_user_id: maya, reason: 'catan' }));
  expect((intro.result as any).error).toBeTruthy();
});

test("someone else's event: no one is kept out, the blocker gets a heads-up either way", async () => {
  const { maya, nate, owen } = await campus();
  await blockPerson(maya, 'nate sullivan');
  const ev = await createEvent(owen, { ...boardGames, capacity: 8, location: 'Odegaard' });

  // Maya is going; then Nate joins -> Maya is told, Nate isn't told anything about the block.
  expect((await joinEvent(maya, ev.id)).outcome).toBe('accepted');
  const r = await joinEvent(nate, ev.id);
  expect(r.outcome).toBe('accepted');
  expect(r.detail).not.toMatch(/heads up/i);
  expect((await textsTo(maya)).at(-1)).toMatch(/heads up: Nate just joined Board game night/);

  // The other order: Nate is going, Maya joins -> her confirmation carries the heads-up, and discover/context flag it.
  const { maya: m2, nate: n2, owen: o2 } = await campus();
  await blockPerson(m2, 'nate');
  const ev2 = await createEvent(o2, { ...boardGames, capacity: 8, location: 'Odegaard' });
  await joinEvent(n2, ev2.id);
  expect((await discoverEvents(m2, 'board game night')).find((e) => e.id === ev2.id)?.headsUp).toEqual(['Nate']);
  const mine = await joinEvent(m2, ev2.id);
  expect(mine.detail).toMatch(/heads up: Nate is going too/);
  expect(await contextBlock((await getUser(m2))!, T0)).toContain('HEADS UP: going includes someone they blocked: Nate');
});

test('block_person reports events where they will already see that person; unblock restores matching', async () => {
  const { maya, nate, owen } = await campus();
  const ev = await createEvent(owen, { ...boardGames, capacity: 8, location: 'Odegaard' });
  await joinEvent(maya, ev.id);
  await joinEvent(nate, ev.id);
  const res = await runTool(maya, 'block_person', JSON.stringify({ name: 'nate sullivan' }));
  expect((res.result as any).heads_up).toEqual([expect.objectContaining({ event_id: ev.id, name: 'Nate' })]);
  expect((await findPeople(maya, 'catan and board games', 10)).map((m) => m.userId)).not.toContain(nate);
  expect(await unblockPerson(maya, 'Nate Sullivan')).toBe(1);
  expect((await findPeople(maya, 'catan and board games', 10)).map((m) => m.userId)).toContain(nate);
});

// ---------- requirements ----------

test('event person rule: off that one event only; names match whole words ("nate" is not Nathan)', async () => {
  await fresh();
  const host = await makeUser('Priya Shah', 'Core Interests:\n[1] Tabletop board games, Catan, game nights (Vibe: Casual).');
  const nate = await makeUser('Nate Fox', 'Core Interests:\n[1] Tabletop board games, Catan, game nights (Vibe: Casual).');
  const nathan = await makeUser('Nathan Cole', 'Core Interests:\n[1] Tabletop board games, Catan, game nights (Vibe: Casual).');
  const one = await createEvent(host, { ...boardGames, requirements: [{ kind: 'person', person: 'Nate', strength: 'must', said: 'not nate this time' }] });
  const two = await createEvent(host, { ...boardGames, title: 'Catan night 2' });
  await advance(0);
  const first = (await invitedTo(one.id)).map((r) => r.user_id);
  expect(first).not.toContain(nate);
  expect(first).toContain(nathan);
  expect((await invitedTo(two.id)).map((r) => r.user_id)).toContain(nate);
});

test("text rule (must): only people whose own profile says it; fails are remembered and never re-checked", async () => {
  const { fake, maya } = await campus();
  judge(fake, (profile) => /advanced|competitive|4\.5|5\.0|varsity/i.test(profile));
  const ev = await createEvent(maya, {
    ...boardGames,
    title: 'Competitive doubles tennis',
    description: 'doubles tennis at the IMA courts',
    requirements: [{ kind: 'text', criterion: 'advanced tennis, 4.0+', strength: 'must', said: 'only good players' }],
  });
  await advance(0);
  const invited = await q<{ canonical_profile: string }>(
    `SELECT u.canonical_profile FROM event_invites i JOIN users u ON u.id = i.user_id WHERE i.event_id = $1`,
    [ev.id],
  );
  expect(invited.length).toBeGreaterThan(0);
  for (const p of invited) expect(p.canonical_profile).toMatch(/advanced|competitive|4\.5|5\.0|varsity/i);
  const screenedOut = await q<{ user_id: number }>(`SELECT user_id FROM screenings WHERE context = $1 AND verdict = 'fail'`, [`event:${ev.id}`]);
  expect(screenedOut.length).toBeGreaterThan(0);
  // Later rounds never recall someone already screened out.
  await advance(6 * HOUR);
  const again = (await invitedTo(ev.id)).map((r) => r.user_id);
  for (const s of screenedOut) expect(again).not.toContain(s.user_id);
});

test("text rule with no judge available fails closed: nobody unverified gets invited", async () => {
  const { maya } = await campus();
  const ev = await createEvent(maya, { ...boardGames, requirements: [{ kind: 'text', criterion: 'queer folks', strength: 'must', said: 'queer game night' }] });
  await advance(0);
  expect(await invitedTo(ev.id)).toHaveLength(0);
});

test('text rule (prefer) reorders instead of filtering', async () => {
  const { fake, maya } = await campus();
  judge(fake, (profile) => /beginner/i.test(profile));
  const ev = await createEvent(maya, { ...boardGames, requirements: [{ kind: 'text', criterion: 'new to board games', strength: 'prefer', said: 'beginners if possible' }] });
  await advance(0);
  const rows = await q<{ canonical_profile: string }>(
    `SELECT u.canonical_profile FROM event_invites i JOIN users u ON u.id = i.user_id WHERE i.event_id = $1`,
    [ev.id],
  );
  expect(rows.length).toBeGreaterThan(0); // nobody filtered out for failing a 'prefer'
});

test("self-serve join is checked against the host's must rules once, then remembered", async () => {
  const { fake, maya, owen } = await campus();
  judge(fake, () => false); // nobody qualifies
  const ev = await createEvent(owen, { ...boardGames, requirements: [{ kind: 'text', criterion: 'advanced chess, 1800+', strength: 'must', said: 'serious chess only' }] });
  const r = await joinEvent(maya, ev.id);
  expect(r.outcome).toBe('closed');
  expect(r.detail).toMatch(/set .* up for advanced chess, 1800\+/);
  // Screened out on a must rule -> the event no longer shows up for her at all.
  expect((await discoverEvents(maya, 'chess')).find((e) => e.id === ev.id)).toBeUndefined();
  // Someone not yet checked still sees who it's for.
  const nate = (await q<{ id: number }>(`SELECT id FROM users WHERE name = 'Nate Sullivan'`))[0].id;
  expect((await discoverEvents(nate, 'chess board games')).find((e) => e.id === ev.id)?.forWho).toEqual(['for: advanced chess, 1800+']);
});

test('policy: no gender filters, no protected traits; communities people mention themselves are fine', () => {
  const bad = (criterion: string) => () => validate({ kind: 'text', criterion, strength: 'must', said: '' }, 1);
  expect(bad('girls only')).toThrow(RequirementError);
  expect(bad('women who climb')).toThrow(/gender/);
  expect(bad('no muslim people')).toThrow(/religion/);
  expect(bad('asian students only')).toThrow(RequirementError);
  expect(() => validate({ kind: 'text', criterion: 'queer folks', strength: 'prefer', said: '' }, 1)).not.toThrow();
  expect(() => validate({ kind: 'text', criterion: 'into asian cooking and dumplings', strength: 'must', said: '' }, 1)).not.toThrow();
  expect(() => validate({ kind: 'person', person: 'sam', strength: 'must', said: '' }, null)).toThrow(/block_person/);
});

test('agent tools: create_event takes requirements; exclusions never go into the description', async () => {
  const { maya, nate } = await campus();
  const bad = await runTool(maya, 'create_event', JSON.stringify({
    title: 'Board game night', description: 'Catan night. Nate Sullivan should not be invited.',
    starts_at: '2026-10-21T19:00:00-07:00', location: 'HUB', capacity: 5, requirements: [],
  }));
  expect((bad.result as any).error).toMatch(/block_person|requirements/);
  const girls = await runTool(maya, 'create_event', JSON.stringify({
    title: 'Board game night', description: 'catan night', starts_at: '2026-10-21T19:00:00-07:00', location: 'HUB', capacity: 5,
    requirements: [{ kind: 'text', person: null, criterion: 'girls only', strength: 'must', said: 'girls only pls' }],
  }));
  expect((girls.result as any).error).toMatch(/gender/);
  expect(await q('SELECT 1 FROM events')).toHaveLength(0);

  const ok = await runTool(maya, 'create_event', JSON.stringify({
    title: 'Board game night', description: 'catan night', starts_at: '2026-10-21T19:00:00-07:00', location: 'HUB', capacity: 5,
    requirements: [{ kind: 'person', person: 'nate sullivan', criterion: null, strength: 'must', said: 'not nate' }],
  }));
  expect((ok.result as any).ok).toBe(true);
  await advance(0);
  expect((await invitedTo((ok.result as any).event_id)).map((r) => r.user_id)).not.toContain(nate);
  const req = await addRequirement(maya, { kind: 'text', criterion: 'queer folks', strength: 'prefer', said: 'queer friends' }, null);
  expect(await contextBlock((await getUser(maya))!, T0)).toContain(`requirement_id ${req.id}: standing (finding people) | prefer | queer folks`);
});
