import { test, expect } from 'vitest';
import { fresh, makeUser, T0 } from './helpers.ts';
import { HOUR } from '../src/clock.ts';
import { q } from '../src/db/index.ts';
import { attendeesFor, createEvent, discoverEvents, joinEvent, plansFor, respondToInvite } from '../src/events/index.ts';
import { contextBlock, buildInput } from '../src/agent/context.ts';
import { getUser } from '../src/db/index.ts';
import { recordInbound } from '../src/transport/index.ts';

// Real events + matching modules on fake embeddings; the fake LLM has no handlers, so every step uses its fallback.

async function soccerEvent() {
  const host = await makeUser('Diego Ramos', 'Core Interests:\n[1] Pickup soccer, futsal, casual outdoor games at Denny Field (Vibe: Casual).');
  const ev = await createEvent(host, {
    title: 'Pickup soccer',
    description: 'casual pickup soccer at Denny Field, all levels',
    startsAt: new Date(T0.getTime() + 30 * HOUR),
    location: 'Denny Field',
    capacity: 4,
  });
  return { host, ev };
}

test('attendees = host + confirmed guests, with how each joined', async () => {
  await fresh();
  const { host, ev } = await soccerEvent();
  const ana = await makeUser('Ana Ruiz', 'Core Interests:\n[1] Pickup soccer and futsal, casual games (Vibe: Casual).');
  const ben = await makeUser('Ben Okafor', 'Core Interests:\n[1] Sourdough baking and bread (Vibe: Chill).');

  // Ana comes in through discover; Ben gets a direct invite row and says yes.
  expect((await joinEvent(ana, ev.id)).outcome).toBe('accepted');
  await q(`INSERT INTO event_invites (event_id, user_id, wave, pitch, invited_at) VALUES ($1, $2, 1, 'x', $3) ON CONFLICT DO NOTHING`, [ev.id, ben, T0.toISOString()]);
  await respondToInvite(ben, ev.id, 'yes');

  const roster = await attendeesFor(ev.id);
  expect(roster.map((a) => [a.name.split(' ')[0], a.role, a.source])).toEqual([
    ['Diego', 'host', 'host'],
    ['Ana', 'guest', 'discover'],
    ['Ben', 'guest', 'invite'],
  ]);

  // Backing out removes them from the roster; the row stays as history.
  await respondToInvite(ben, ev.id, 'cancel');
  expect((await attendeesFor(ev.id)).map((a) => a.userId)).toEqual([host, ana]);
  expect((await q(`SELECT status FROM event_invites WHERE event_id = $1 AND user_id = $2`, [ev.id, ben]))[0].status).toBe('cancelled');
});

test('plans list upcoming events for host and guests, with who else is going', async () => {
  await fresh();
  const { host, ev } = await soccerEvent();
  const ana = await makeUser('Ana Ruiz', 'Core Interests:\n[1] Pickup soccer and futsal (Vibe: Casual).');
  await joinEvent(ana, ev.id);

  const [mine] = await plansFor(ana);
  expect(mine.role).toBe('guest');
  expect(mine.attendees.map((a) => a.name.split(' ')[0])).toEqual(['Diego', 'Ana']);
  expect((await plansFor(host))[0].role).toBe('host');

  const ctx = await contextBlock((await getUser(ana))!, T0);
  expect(ctx).toContain("their plans: upcoming events they're going to");
  expect(ctx).toContain('going: Diego (host)');
});

test('discover returns a fit score and ranks the matching event first', async () => {
  await fresh();
  const { ev } = await soccerEvent();
  const other = await makeUser('Kim Lee', 'Core Interests:\n[1] Jazz piano (Level: Intermediate).');
  await createEvent(other, {
    title: 'Jazz jam',
    description: 'jazz jam session with piano and sax',
    startsAt: new Date(T0.getTime() + 30 * HOUR),
    location: 'Music building',
    capacity: 3,
  });
  const me = await makeUser('Sam Park', 'Core Interests:\n[1] Running (Level: Beginner).');
  const res = await discoverEvents(me, 'pickup soccer or something');
  expect(res[0].id).toBe(ev.id);
  expect(res[0].fit).toBeGreaterThan(res[1].fit!);
});

test('context flags the first text and goes after the conversation history', async () => {
  await fresh();
  const maya = await makeUser('Maya Chen', 'Core Interests:\n[1] Competitive tennis, USTA 4.5 (Level: Advanced).');
  await recordInbound(maya, 'hi');
  const first = await buildInput((await getUser(maya))!, T0);
  expect(first.at(-1)).toMatchObject({ role: 'developer' });
  expect((first.at(-1) as { content: string }).content).toContain('FIRST text they have ever sent mixr (a profile already exists');

  await recordInbound(maya, 'anything going on?');
  const later = await buildInput((await getUser(maya))!, T0);
  expect((later.at(-1) as { content: string }).content).toContain('returning user');
  expect(later[0]).toMatchObject({ role: 'user', content: 'hi' });
});

test('context lists which mixr features they have used and which they have not tried yet', async () => {
  await fresh();
  const maya = await makeUser('Maya Chen', 'Core Interests:\n[1] Competitive tennis, USTA 4.5 (Level: Advanced).');
  const { trace } = await import('../src/trace.ts');
  const { featureUse } = await import('../src/agent/context.ts');
  expect((await featureUse(maya)).used).toEqual([]);

  await trace('agent', maya, { toolCalls: [{ name: 'find_people', args: {}, result: {} }] });
  await createEvent(maya, { title: 'Doubles', description: 'competitive doubles', startsAt: new Date(T0.getTime() + 30 * HOUR), location: 'IMA', capacity: 3 });
  const f = await featureUse(maya);
  expect(f.used).toEqual(['finding people to meet (intros)', 'hosting an event (mixr invites people who fit)']);
  expect(f.notYet).toContain("browsing what's going on (discover)");
  expect(await contextBlock((await getUser(maya))!, T0)).toContain('not tried yet (candidates for one relevant tip):');
});
