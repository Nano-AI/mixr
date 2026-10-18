import { beforeEach, expect, test, vi } from 'vitest';
import { fresh, makeUser, axis, T0 } from './helpers.ts';
import { q, toVec } from '../src/db/index.ts';
import { trace } from '../src/trace.ts';
import type { FakeLlm } from '../src/llm/index.ts';

// Other modules are mid-implementation; the server only needs them importable.
vi.mock('../src/profiles/index.ts', () => ({ buildProfile: vi.fn(), editProfile: vi.fn(), setProfileText: vi.fn(), evolveFromRsvp: vi.fn() }));
vi.mock('../src/events/index.ts', () => ({
  createEvent: vi.fn(),
  respondToInvite: vi.fn(),
  manageEvent: vi.fn(),
  discoverEvents: vi.fn(async () => []),
  openInvitesFor: vi.fn(async () => []),
  hostedEventsFor: vi.fn(async () => []),
  joinEvent: vi.fn(),
}));
vi.mock('../src/matching/index.ts', () => ({ recall: vi.fn(), rerank: vi.fn(), findPeople: vi.fn() }));
vi.mock('../src/relay/index.ts', () => ({ requestIntro: vi.fn(), respondToIntro: vi.fn(), pendingIntrosFor: vi.fn(async () => []), IntroLimitError: class extends Error {}, groundedNote: vi.fn(() => undefined) }));

const { app } = await import('../src/server.ts');

let fake: FakeLlm;
beforeEach(async () => {
  fake = await fresh();
});

const post = (path: string, body: unknown) => app.request(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

test('GET /api/state returns users, events with going/cosToE0/invites, intros and usage', async () => {
  const host = await makeUser('Sam Lee', 'board games');
  const guest = await makeUser('Jo', 'board games');
  await q(
    `INSERT INTO events (host_id, title, raw_description, starts_at, location, capacity, hyde_profile, initial_embedding, current_embedding, created_at)
     VALUES ($1, 'Catan', 'catan night', $2, 'HUB', 4, 'Target Attendee', $3, $4, $2)`,
    [host, T0.toISOString(), toVec(axis(0)), toVec(axis(0))],
  );
  await q(`INSERT INTO event_invites (event_id, user_id, wave, pitch, status, invited_at) VALUES (1, $1, 1, 'hey', 'yes', $2)`, [guest, T0.toISOString()]);
  await q(`INSERT INTO intros (requester_id, target_id, reason, status, created_at) VALUES ($1, $2, 'catan', 'target_asked', $3)`, [guest, host, T0.toISOString()]);
  await trace('llm', null, { purpose: 'agent', usage: { input_tokens: 100, output_tokens: 20 } });
  await trace('llm', null, { purpose: 'rerank', usage: { input_tokens: 50, output_tokens: 5 } });
  await trace('embed', null, { count: 1, cached: 0, tokens: 7 });

  const res = await app.request('/api/state');
  expect(res.status).toBe(200);
  const s = await res.json();
  expect(s.now).toBe(T0.toISOString());
  expect(s.users).toHaveLength(2);
  expect(s.users[0]).toMatchObject({ id: host, name: 'Sam Lee', state: 'active', snoozedUntil: null, seeded: true });
  expect(s.users[0].profile).toBe('board games');
  expect(s.events[0]).toMatchObject({ id: 1, hostId: host, hostName: 'Sam Lee', title: 'Catan', description: 'catan night', capacity: 4, status: 'open', waveNumber: 0, going: 1, nextWaveAt: null, startsAt: T0.toISOString() });
  expect(s.events[0].cosToE0).toBeCloseTo(1);
  expect(s.events[0].invites[0]).toMatchObject({ userId: guest, name: 'Jo', wave: 1, status: 'yes', pitch: 'hey', respondedAt: null });
  expect(s.intros[0]).toMatchObject({ requesterName: 'Jo', targetName: 'Sam Lee', reason: 'catan', status: 'target_asked' });
  expect(s.usage).toEqual({ llmCalls: 2, byPurpose: { agent: 1, rerank: 1 }, inputTokens: 150, outputTokens: 25, embedTokens: 7 });
});

test('POST /api/clock/advance moves the sim clock', async () => {
  const res = await post('/api/clock/advance', { minutes: 60 });
  expect(await res.json()).toEqual({ now: new Date(T0.getTime() + 3_600_000).toISOString(), jobsRan: 0 });
  expect((await post('/api/clock/advance', { minutes: -1 })).status).toBe(400);
});

test('POST /api/inbound runs the agent; messages and traces endpoints read it back', async () => {
  fake.agentHandler = () => ({ text: 'hey! what should i call you?', calls: [] });
  const res = await post('/api/inbound', { phone: '+15550009999', text: 'hi' });
  expect(await res.json()).toEqual({ ok: true });

  const msgs = await (await app.request('/api/messages/' + encodeURIComponent('+15550009999'))).json();
  expect(msgs.map((m: any) => [m.direction, m.text])).toEqual([
    ['in', 'hi'],
    ['out', 'hey! what should i call you?'],
  ]);
  expect(msgs[0].simTime).toBe(T0.toISOString());

  const traces = await (await app.request('/api/traces?kind=agent')).json();
  expect(traces).toHaveLength(1);
  expect(traces[0]).toMatchObject({ kind: 'agent', data: { phone: '+15550009999' } });

  fake.agentHandler = () => {
    throw new Error('nope');
  };
  expect(await (await post('/api/inbound', { phone: '+15550009999', text: 'hi' })).json()).toEqual({ ok: false, error: 'nope' });
});
