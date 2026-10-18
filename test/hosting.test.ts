import { test, expect } from 'vitest';
import { fresh } from './helpers.ts';
import { getUserByPhone, q } from '../src/db/index.ts';
import { seed } from '../src/seed.ts';
import { runTool } from '../src/agent/tools.ts';
import '../src/profiles/index.ts';

// Hosting through the agent's tools: the first round goes out inside create_event so the reply can report it,
// and a host can change who it's for afterwards.

const event = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    title: 'Tennis meetup',
    description: 'tennis meetup at the IMA courts',
    starts_at: '2026-10-21T18:00:00-07:00',
    location: 'IMA',
    capacity: 9,
    requirements: [],
    ...over,
  });

const textsTo = async (userId: number) =>
  (await q<{ text: string }>(`SELECT text FROM messages WHERE user_id = $1 AND direction = 'out' ORDER BY id`, [userId])).map((r) => r.text);

test('create_event sends the first round right away and reports how many went out', async () => {
  await fresh();
  await seed();
  const maya = (await getUserByPhone('+12065550101'))!.id;
  const r = (await runTool(maya, 'create_event', event())).result as any;
  expect(r.ok).toBe(true);
  expect(r.invited_now).toBeGreaterThan(0);
  const sent = await q<{ n: number }>('SELECT count(*)::int AS n FROM event_invites WHERE event_id = $1', [r.event_id]);
  expect(r.invited_now).toBe(sent[0].n);
  expect(r.first_round).toMatch(/fits/);
});

test('a first round with nobody who fits is reported by the reply, not by a second "pool is thin" text', async () => {
  await fresh();
  await seed();
  const maya = (await getUserByPhone('+12065550101'))!.id;
  const before = (await textsTo(maya)).length;
  // A 'must' text rule with no judge available: nobody can be verified, so nobody is invited.
  const r = (await runTool(maya, 'create_event', event({ requirements: [{ kind: 'text', person: null, criterion: 'advanced tennis, 4.5+', strength: 'must', said: 'only 4.5s' }] })))
    .result as any;
  expect(r.invited_now).toBe(0);
  expect(r.first_round).toMatch(/nobody on mixr fits yet/);
  expect((await textsTo(maya)).length).toBe(before);
});

test('update_description re-targets the event and reaches out to newly fitting people at once', async () => {
  await fresh();
  await seed();
  const maya = (await getUserByPhone('+12065550101'))!.id;
  const r = (await runTool(maya, 'create_event', event({ capacity: 20, description: 'competitive 4.5 tennis sets at the IMA' }))).result as any;
  const before = r.invited_now;
  const up = (await runTool(maya, 'manage_event', JSON.stringify({ event_id: r.event_id, action: 'update_description', n: null, description: 'tennis at the IMA, any level welcome, plus pickup sports folks' })))
    .result as any;
  expect(up.result).toMatch(/updated/);
  const after = await q<{ n: number }>('SELECT count(*)::int AS n FROM event_invites WHERE event_id = $1', [r.event_id]);
  expect(after[0].n).toBeGreaterThan(before);
  const ev = await q<{ raw_description: string }>('SELECT raw_description FROM events WHERE id = $1', [r.event_id]);
  expect(ev[0].raw_description).toMatch(/any level welcome/);

  const named = await runTool(maya, 'manage_event', JSON.stringify({ event_id: r.event_id, action: 'update_description', n: null, description: 'tennis with Ethan Okafor' }));
  expect((named.result as any).error).toMatch(/name other students/);
});

test('activity searches always end up offering to host an event, even if the model forgets', async () => {
  const { withHostOffer } = await import('../src/agent/index.ts');
  const search = [{ name: 'find_people', args: { request: 'tennis players around 4.5' }, result: { matches: [] } }];
  const forgot = withHostOffer('ethan plays 4.5. want me to ask him?', search);
  expect(forgot).toMatch(/host an event/);
  const already = 'want me to ask ethan, or host a tennis event for you?';
  expect(withHostOffer(already, search)).toBe(already); // not doubled
  expect(withHostOffer('here are some people like you', [{ name: 'find_people', args: { request: null }, result: {} }])).not.toMatch(/host/);
  expect(withHostOffer('sure', [])).toBe('sure');

  await fresh();
  await seed();
  const maya = (await getUserByPhone('+12065550101'))!.id;
  const r = (await runTool(maya, 'find_people', JSON.stringify({ request: 'tennis players' }))).result as any;
  expect(r.also_offer).toMatch(/host .*event/);
  const general = (await runTool(maya, 'find_people', JSON.stringify({ request: null }))).result as any;
  expect(general.also_offer).toBeUndefined();
});
