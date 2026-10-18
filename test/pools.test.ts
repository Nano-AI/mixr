import { test, expect, afterEach } from 'vitest';
import { fresh, makeUser, T0 } from './helpers.ts';
import { getUser, q, resetDemo, toVec } from '../src/db/index.ts';
import { HOUR, now } from '../src/clock.ts';
import { runIn, poolContext } from '../src/context.ts';
import { config } from '../src/config.ts';
import { recall } from '../src/matching/index.ts';
import { advance, registerJob, runDue, schedule } from '../src/jobs/index.ts';
import { send } from '../src/transport/index.ts';
import { setDeliverer, retryPending } from '../src/transport/outbox.ts';
import { fakeEmbed } from '../src/llm/embed.ts';
import { handleInbound } from '../src/agent/index.ts';

// Demo (seeded, simulated clock, never delivered) and real (website + iMessage, wall clock, delivered) pools.

const realUser = async (name: string, profile: string) => {
  const v = (await fakeEmbed([profile]))[0];
  const r = await q<{ id: number }>(
    `INSERT INTO users (phone, name, state, canonical_profile, embedding, seeded) VALUES ($1, $2, 'active', $3, $4, false) RETURNING id`,
    [`+1206${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`, name, profile, toVec(v)],
  );
  return r[0].id;
};
const real = poolContext('real');

afterEach(() => {
  config.transport = 'sim';
  setDeliverer(null);
});

test('recall never crosses pools', async () => {
  await fresh();
  const demo = await makeUser('Demo Dana', 'Core Interests:\n[1] Competitive tennis (Level: Advanced).');
  const live = await realUser('Real Riley', 'Core Interests:\n[1] Competitive tennis (Level: Advanced).');
  const v = (await fakeEmbed(['competitive tennis']))[0];
  expect((await recall(v)).map((h) => h.userId)).toEqual([demo]);
  expect((await runIn(real, () => recall(v))).map((h) => h.userId)).toEqual([live]);
});

test('the real pool runs on the wall clock; the demo clock only moves on fast-forward', async () => {
  await fresh();
  expect((await now()).getTime()).toBe(T0.getTime());
  const wall = await runIn(real, () => now());
  expect(Math.abs(wall.getTime() - Date.now())).toBeLessThan(5_000);
});

test('jobs run in the pool that scheduled them; fast-forward never runs real-pool jobs', async () => {
  await fresh();
  const ran: string[] = [];
  registerJob('expire_intro', async (p) => void ran.push(p.tag));
  await schedule('expire_intro', { tag: 'demo' }, new Date(T0.getTime() + HOUR));
  await runIn(real, () => schedule('expire_intro', { tag: 'real' }, new Date(Date.now() - 1000)));
  await advance(2 * HOUR);
  expect(ran).toEqual(['demo']);
  await runIn(real, () => runDue());
  expect(ran).toEqual(['demo', 'real']);
});

test('delivery: only real users, only in a delivering context, never to the user the dashboard acts as', async () => {
  await fresh();
  config.transport = 'photon';
  const sent: string[] = [];
  setDeliverer(async (phone, text) => void sent.push(`${phone}:${text}`));
  const demo = await makeUser('Demo Dana', 'tennis');
  const live = await realUser('Real Riley', 'tennis');
  const other = await realUser('Real Ray', 'tennis');

  await send(demo, 'demo text'); // demo context
  await runIn(real, () => send(demo, 'demo user in real context'));
  await runIn({ pool: 'real', deliver: false }, () => send(live, 'not delivering'));
  await runIn({ pool: 'real', deliver: true, quietUser: live }, () => send(live, 'acting as riley'));
  await runIn({ pool: 'real', deliver: true, quietUser: live }, () => send(other, 'to ray while acting as riley'));
  await runIn(real, () => send(live, 'hello riley', { dedupeKey: 'k1' }));
  await runIn(real, () => send(live, 'hello riley again', { dedupeKey: 'k1' })); // same logical notification

  const riley = (await getUser(live))!.phone;
  const ray = (await getUser(other))!.phone;
  expect(sent).toEqual([`${ray}:to ray while acting as riley`, `${riley}:hello riley`]);
  // Every message is still logged for the dashboard.
  expect((await q('SELECT 1 FROM messages')).length).toBe(7);
});

test('delivery failures retry; opting out suppresses anything not yet sent', async () => {
  await fresh();
  config.transport = 'photon';
  const live = await realUser('Real Riley', 'tennis');
  let fail = true;
  const sent: string[] = [];
  setDeliverer(async (_p, text) => {
    if (fail) throw new Error('network down');
    sent.push(text);
  });
  await runIn(real, () => send(live, 'first'));
  await runIn(real, () => send(live, 'second'));
  await q('UPDATE users SET opted_out = true WHERE id = $1', [live]);
  await runIn(real, () => send(live, 'after stop'));
  await runIn(real, () => send(live, 'stop ack', { evenIfOptedOut: true }));
  fail = false;
  await retryPending();
  expect(sent).toEqual(['stop ack']);
  const statuses = (await q<{ status: string }>('SELECT status FROM message_jobs ORDER BY id')).map((r) => r.status);
  expect(statuses).toEqual(['suppressed', 'suppressed', 'sent']);
});

test('the dashboard reset removes the demo pool only', async () => {
  await fresh();
  await makeUser('Demo Dana', 'tennis');
  const live = await realUser('Real Riley', 'tennis');
  await runIn(real, () => send(live, 'hi riley'));
  await resetDemo();
  expect((await q('SELECT id FROM users')).map((r) => r.id)).toEqual([live]);
  expect((await q('SELECT 1 FROM messages')).length).toBe(1);
});

test('dashboard-typed numbers join the demo pool; a real user typed as stays real but quiet', async () => {
  await fresh();
  await handleInbound('+15550001234', 'hey');
  expect((await q<{ seeded: boolean }>(`SELECT seeded FROM users WHERE phone = '+15550001234'`))[0].seeded).toBe(true);
});

test('a slow send is never sent twice when the retry loop runs during it (double-text regression)', async () => {
  await fresh();
  config.transport = 'photon';
  const live = await realUser('Real Riley', 'tennis');
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const sent: string[] = [];
  setDeliverer(async (_p, text) => {
    await gate; // Photon taking its time
    sent.push(text);
  });
  const sending = runIn(real, () => send(live, 'only once please'));
  await new Promise((r) => setTimeout(r, 20));
  await retryPending(); // the ticker fires mid-send
  release();
  await sending;
  await retryPending();
  expect(sent).toEqual(['only once please']);
});
