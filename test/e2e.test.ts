import { test, expect } from 'vitest';
import { fresh, T0 } from './helpers.ts';
import { q, getUserByPhone } from '../src/db/index.ts';
import { seed } from '../src/seed.ts';
import { HOUR } from '../src/clock.ts';
import { advance } from '../src/jobs/index.ts';
import { createEvent, respondToInvite } from '../src/events/index.ts';
import { findPeople } from '../src/matching/index.ts';
import { requestIntro, respondToIntro } from '../src/relay/index.ts';
import { handleInbound } from '../src/agent/index.ts';
import '../src/profiles/index.ts';

// Real modules wired together, fake LLM with no handlers (every pipeline step on its fallback), fake embeddings.

const outbox = async (userId: number) =>
  (await q<{ text: string }>(`SELECT text FROM messages WHERE user_id = $1 AND direction = 'out' ORDER BY id`, [userId])).map((r) => r.text);

test('seeded campus: hosted tennis event fills through hidden waves without overfilling', async () => {
  await fresh();
  expect(await seed()).toBe(50);
  const host = (await getUserByPhone('+12065550101'))!;

  const ev = await createEvent(host.id, {
    title: 'Competitive doubles tennis',
    description: 'Looking for 3 people for competitive doubles tennis, USTA 4.0+ match play',
    startsAt: new Date(T0.getTime() + 48 * HOUR),
    location: 'IMA tennis courts',
    capacity: 3,
  });
  await advance(0);

  const wave1 = await q<{ user_id: number }>(`SELECT user_id FROM event_invites WHERE event_id = $1 AND wave = 1`, [ev.id]);
  expect(wave1.length).toBeGreaterThanOrEqual(3);
  // Recall should favour tennis players.
  const tennis = await q(`SELECT u.id FROM users u JOIN event_invites i ON i.user_id = u.id WHERE i.event_id = $1 AND u.canonical_profile ILIKE '%tennis%'`, [ev.id]);
  expect(tennis.length).toBeGreaterThan(wave1.length / 2);

  // Everyone in wave 1 says yes: exactly 3 get in, the rest wait, the host hears "full" once.
  const results = [];
  for (const { user_id } of wave1) results.push((await respondToInvite(user_id, ev.id, 'yes')).outcome);
  expect(results.filter((r) => r === 'accepted')).toHaveLength(3);
  const yes = await q(`SELECT 1 FROM event_invites WHERE event_id = $1 AND status = 'yes'`, [ev.id]);
  expect(yes).toHaveLength(3);
  expect((await outbox(host.id)).filter((t) => /full/i.test(t))).toHaveLength(1);

  // Time passes: no more invites go out for a full event, and nothing user-facing leaks the mechanics.
  await advance(24 * HOUR);
  const waves = await q<{ w: number }>(`SELECT max(wave) AS w FROM event_invites WHERE event_id = $1`, [ev.id]);
  expect(waves[0].w).toBe(1);
  const all = await q<{ text: string }>(`SELECT text FROM messages WHERE direction = 'out'`);
  expect(all.some((m) => /\b(wave|vector|score|algorithm)\b/i.test(m.text))).toBe(false);
});

test('find people → intro relay → both sides get numbers', async () => {
  await fresh();
  await seed();
  const me = (await getUserByPhone('+12065550101'))!;
  const matches = await findPeople(me.id, 'someone to play tennis with');
  expect(matches.length).toBeGreaterThan(0);
  const intro = await requestIntro(me.id, matches[0].userId, 'tennis hitting partner');
  const done = await respondToIntro(matches[0].userId, intro.id, true, 'free thursday 4pm');
  expect(done.status).toBe('connected');
  expect((await outbox(me.id)).at(-1)).toContain('free thursday 4pm');
});

test('a brand-new phone gets a reply from the agent', async () => {
  await fresh();
  await handleInbound('+15550001111', 'hey');
  const u = (await getUserByPhone('+15550001111'))!;
  expect(u.state).toBe('onboarding');
  expect((await outbox(u.id)).length).toBe(1);
});
