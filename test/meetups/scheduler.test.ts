import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, reset } from '../../src/db.ts';
import { createProposal } from '../../src/meetups/proposals.ts';
import { recordResponse } from '../../src/meetups/responses.ts';
import { tick } from '../../src/meetups/scheduler.ts';
import { makeUser, axis } from '../helpers.ts';

// Oct 22 2026 is a Thursday. Tests run with TZ=America/Los_Angeles.
const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m);
const NOW = at(22, 8);
const SLOT = at(22, 17);
const noPlan = async () => 0;

const jobs = (prefix: string) => db.prepare('SELECT * FROM message_jobs WHERE dedupe_key LIKE ?').all(`${prefix}:%`) as { text: string }[];
const count = () => (db.prepare('SELECT COUNT(*) c FROM message_jobs').get() as { c: number }).c;
const state = (id: number) => (db.prepare('SELECT state FROM meetups WHERE id = ?').get(id) as { state: string }).state;
const afterDeadline = (deadline: string) => new Date(new Date(deadline).getTime() + 1000);

async function setup(accept: number) {
  reset();
  const users = [makeUser(), makeUser(), makeUser()];
  const m = await createProposal({ kind: 'group', activity: 'frisbee', category: 'sport', vector: axis(0), slot: SLOT.toISOString(), userIds: users, visibility: 'public' }, NOW);
  for (const u of users.slice(0, accept)) await recordResponse(u, m.id, 'yes', NOW);
  return { m, users };
}

test('past deadline with 2 of 3 accepted: expired, accepted users told once', async () => {
  const { m, users } = await setup(2);
  await tick(afterDeadline(m.deadline), noPlan);
  assert.equal(state(m.id), 'expired');
  assert.equal(jobs('expire').length, 2);
  assert.match(jobs('expire')[0].text, /Not enough people said yes for frisbee/);
  const inv = db.prepare('SELECT state FROM invitations WHERE meetup_id = ? AND user_id = ?').get(m.id, users[2]) as { state: string };
  assert.equal(inv.state, 'expired');
});

test('before deadline nothing expires', async () => {
  const { m } = await setup(2);
  await tick(NOW, noPlan);
  assert.equal(state(m.id), 'proposed');
});

test('tick twice at the same now adds no message_jobs', async () => {
  const { m } = await setup(2);
  const t = afterDeadline(m.deadline);
  await tick(t, noPlan);
  const n = count();
  await tick(t, noPlan);
  assert.equal(count(), n);
});

test('reminder only once now >= slot - 2h, and only for confirmed', async () => {
  const { m } = await setup(3);
  assert.equal(state(m.id), 'confirmed');
  await tick(at(22, 14, 59), noPlan);
  assert.equal(jobs('remind').length, 0);
  await tick(at(22, 15), noPlan);
  assert.equal(jobs('remind').length, 3);
  assert.match(jobs('remind')[0].text, new RegExp(`Today Thu 5 PM: frisbee at .*CANCEL ${m.id} if not`));
  await tick(at(22, 15, 30), noPlan);
  assert.equal(jobs('remind').length, 3);
});

test('slot + 2h: done, feedback rows and messages', async () => {
  const { m } = await setup(3);
  await tick(at(22, 18, 59), noPlan);
  assert.equal(state(m.id), 'confirmed');
  await tick(at(22, 19), noPlan);
  assert.equal(state(m.id), 'done');
  const rows = db.prepare('SELECT attended FROM feedback WHERE meetup_id = ?').all(m.id) as { attended: number | null }[];
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.attended === null));
  assert.equal(jobs('feedback').length, 3);
  assert.match(jobs('feedback')[0].text, /How was frisbee\? Reply WENT or MISSED/);
  await tick(at(22, 19), noPlan);
  assert.equal(jobs('feedback').length, 3);
});

test('tick calls the plan function with now', async () => {
  reset();
  let got: Date | undefined;
  await tick(NOW, async (n) => { got = n; return 0; });
  assert.equal(got, NOW);
});
