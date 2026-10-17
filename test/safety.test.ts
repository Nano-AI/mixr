import { test, expect } from 'vitest';
import { fresh, makeUser, T0 } from './helpers.ts';
import { HOUR } from '../src/clock.ts';
import { getUserByPhone, q } from '../src/db/index.ts';
import { advance } from '../src/jobs/index.ts';
import { seed } from '../src/seed.ts';
import { attendeesFor, createEvent, discoverEvents, joinEvent, respondToInvite } from '../src/events/index.ts';
import { findPeople } from '../src/matching/index.ts';
import { excludePerson, shieldedIds } from '../src/safety/index.ts';
import { runTool } from '../src/agent/tools.ts';
import '../src/profiles/index.ts';

// The Maya/Nate incident: a host asked mixr not to invite her ex, the request lived only in LLM-visible text,
// and the reranker invited him anyway. Exclusions are now a hard filter in recall; these tests pin that down.

const MAYA = '+12065550101';
const boardGames = {
  title: 'Board game night',
  description: 'casual board game night, catan, chess, whatever, all levels welcome',
  startsAt: new Date(T0.getTime() + 30 * HOUR),
  location: 'HUB',
  capacity: 5,
};

async function campus() {
  await fresh();
  await seed();
  const maya = (await getUserByPhone(MAYA))!.id;
  const nate = (await q<{ id: number }>(`SELECT id FROM users WHERE name = 'Nate Sullivan'`))[0].id;
  return { maya, nate };
}

const invitedTo = async (eventId: number) =>
  (await q<{ user_id: number; status: string }>('SELECT user_id, status FROM event_invites WHERE event_id = $1', [eventId]));
const textsTo = async (userId: number) =>
  (await q<{ text: string }>(`SELECT text FROM messages WHERE user_id = $1 AND direction = 'out' ORDER BY id`, [userId])).map((r) => r.text);

test('without an exclusion Nate is a top pick for board games (the setup is realistic)', async () => {
  const { maya, nate } = await campus();
  const ev = await createEvent(maya, boardGames);
  await advance(0);
  expect((await invitedTo(ev.id)).map((r) => r.user_id)).toContain(nate);
});

test('excluded before the event exists: never recalled, never invited, across every wave', async () => {
  const { maya, nate } = await campus();
  await excludePerson(maya, 'nate sullivan', null);
  const ev = await createEvent(maya, boardGames);
  await advance(0);
  for (let i = 0; i < 4; i++) await advance(6 * HOUR); // later rounds too
  expect((await invitedTo(ev.id)).map((r) => r.user_id)).not.toContain(nate);
  expect((await textsTo(nate)).some((t) => /board game/i.test(t))).toBe(false);
  // Dropped in stage 1: the recall trace shows it was shielded before ranking.
  const recall = await q<{ data: any }>(`SELECT data FROM traces WHERE kind = 'recall' AND ref_id = $1 ORDER BY id LIMIT 1`, [ev.id]);
  expect(recall[0].data.shielded).toBeGreaterThanOrEqual(1);
  expect(recall[0].data.hits.map((h: any) => h.userId)).not.toContain(nate);
});

test("an LLM reranker that picks him anyway can't: he was never a candidate", async () => {
  const { maya, nate } = await campus();
  const fake = await import('../src/llm/index.ts');
  (fake.llm() as InstanceType<typeof fake.FakeLlm>).onJson('rerank', () => ({
    picks: [{ user_id: nate, reason: 'loves catan', pitch: 'thought of you' }],
  }));
  await excludePerson(maya, 'nate sullivan', null);
  const ev = await createEvent(maya, boardGames);
  await advance(0);
  expect((await invitedTo(ev.id)).map((r) => r.user_id)).not.toContain(nate);
});

test('excluded after invites went out: his pending invite is withdrawn and a later yes is refused', async () => {
  const { maya, nate } = await campus();
  const ev = await createEvent(maya, boardGames);
  await advance(0);
  expect((await invitedTo(ev.id)).find((r) => r.user_id === nate)?.status).toBe('invited');

  const before = (await textsTo(nate)).length;
  expect((await excludePerson(maya, 'nate sullivan', null)).withdrawn).toBe(1);
  expect((await invitedTo(ev.id)).find((r) => r.user_id === nate)?.status).toBe('withdrawn');
  expect((await textsTo(nate)).length).toBe(before); // silent: he isn't told anything

  const r = await respondToInvite(nate, ev.id, 'yes');
  expect(r.outcome).toBe('closed');
  expect((await attendeesFor(ev.id)).map((a) => a.userId)).not.toContain(nate);
});

test("it's mutual: no suggestions, no discover, no joining, no invites to each other's plans", async () => {
  const { maya, nate } = await campus();
  await excludePerson(maya, 'nate sullivan', null);
  expect(await shieldedIds([nate])).toContain(maya);

  const mayas = await createEvent(maya, boardGames);
  expect((await discoverEvents(nate, 'board games catan')).map((e) => e.id)).not.toContain(mayas.id);
  expect((await joinEvent(nate, mayas.id)).outcome).toBe('closed');
  expect((await findPeople(nate, 'catan and board games', 10)).map((m) => m.userId)).not.toContain(maya);
  expect((await findPeople(maya, 'catan and board games', 10)).map((m) => m.userId)).not.toContain(nate);

  // Nate hosts his own game night: Maya is never invited.
  const nates = await createEvent(nate, { ...boardGames, title: 'Catan + snacks', location: 'Odegaard' });
  await advance(0);
  expect((await invitedTo(nates.id)).map((r) => r.user_id)).not.toContain(maya);
});

test("once Maya is going to someone else's event, Nate isn't pulled into it either", async () => {
  const { maya, nate } = await campus();
  await excludePerson(maya, 'nate sullivan', null);
  const owen = (await q<{ id: number }>(`SELECT id FROM users WHERE name = 'Owen Fitzgerald'`))[0].id;
  const ev = await createEvent(owen, { ...boardGames, capacity: 8, location: 'Odegaard' });
  expect((await joinEvent(maya, ev.id)).outcome).toBe('accepted');
  await advance(0);
  for (let i = 0; i < 3; i++) await advance(6 * HOUR);
  expect((await invitedTo(ev.id)).filter((r) => r.user_id === nate)).toHaveLength(0);
});

test('scope event keeps someone off just that event; first-name patterns match whole words only', async () => {
  await fresh();
  const host = await makeUser('Priya Shah', 'Core Interests:\n[1] Tabletop board games, Catan, game nights (Vibe: Casual).');
  const nate = await makeUser('Nate Fox', 'Core Interests:\n[1] Tabletop board games, Catan, game nights (Vibe: Casual).');
  const nathan = await makeUser('Nathan Cole', 'Core Interests:\n[1] Tabletop board games, Catan, game nights (Vibe: Casual).');
  const one = await createEvent(host, boardGames);
  const two = await createEvent(host, { ...boardGames, title: 'Catan night 2' });
  await excludePerson(host, 'Nate', one.id);
  expect(await shieldedIds([host], one.id)).toEqual([nate]);
  expect(await shieldedIds([host], two.id)).toEqual([]);
  expect(await shieldedIds([host])).toEqual([]); // event-only: no lasting block
  await advance(0);
  const firstInvites = (await invitedTo(one.id)).map((r) => r.user_id);
  expect(firstInvites).not.toContain(nate);
  expect(firstInvites).toContain(nathan);
  expect((await invitedTo(two.id)).map((r) => r.user_id)).toContain(nate);
});

test('agent tools: exclusions go through exclude_person, never into a guest-visible description', async () => {
  const { maya } = await campus();
  const bad = await runTool(maya, 'create_event', JSON.stringify({
    title: 'Board game night',
    description: 'Casual board game night with chess and Catan. Nate Sullivan should not be invited.',
    starts_at: '2026-10-21T19:00:00-07:00',
    location: 'HUB',
    capacity: 5,
  }));
  expect((bad.result as any).error).toMatch(/exclude_person/);
  expect((await q('SELECT 1 FROM events')).length).toBe(0);

  const named = await runTool(maya, 'create_event', JSON.stringify({
    title: 'Game night with Owen Fitzgerald', description: 'catan', starts_at: '2026-10-21T19:00:00-07:00', location: 'HUB', capacity: 5,
  }));
  expect((named.result as any).error).toMatch(/name other students/);

  const ex = await runTool(maya, 'exclude_person', JSON.stringify({ name: 'nate sullivan', scope: 'always', event_id: null }));
  expect(ex.result).toMatchObject({ ok: true });
  // No counts or matches come back, so nothing about Nate (on mixr? invited?) can reach Maya's reply.
  expect(Object.keys(ex.result as object).sort()).toEqual(['note', 'ok', 'scope']);

  const nope = await runTool(maya, 'exclude_person', JSON.stringify({ name: 'nate', scope: 'event', event_id: 999 }));
  expect((nope.result as any).error).toMatch(/hosts/);
});
