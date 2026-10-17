import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, fromBlob, reset } from '../../src/db.ts';
import { cosine } from '../../src/matching/vectors.ts';
import { planMeetups } from '../../src/meetups/planner.ts';
import { makeUser, axis } from '../helpers.ts';
import type { Candidate, Criteria } from '../../src/types.ts';

// Oct 22 2026 is a Thursday. Tests run with TZ=America/Los_Angeles.
const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m);
const NOW = at(22, 10);
const SLOT = at(22, 17).toISOString();
const MIN_SIM = 0.45; // mirrors J3's floor

// Minimal stand-in for J3's findCandidates (real one isn't built yet).
function fakeFind(c: Criteria): Candidate[] {
  const exclude = new Set(c.excludeUserIds ?? []);
  const users = db.prepare(
    `SELECT u.id, u.name FROM users u JOIN profiles p ON p.user_id = u.id
     WHERE u.opted_out = 0 AND u.step = 'active' AND p.confirmed = 1 AND u.mode IN (?, 'both')`,
  ).all(c.kind) as { id: number; name: string }[];
  const out: Candidate[] = [];
  for (const u of users) {
    if (exclude.has(u.id)) continue;
    if (c.slot && !db.prepare('SELECT 1 FROM availability WHERE user_id = ? AND slot = ?').get(u.id, c.slot)) continue;
    const ints = db.prepare('SELECT label, embedding FROM interests WHERE user_id = ?').all(u.id) as { label: string; embedding: Uint8Array }[];
    let best: Candidate | undefined;
    for (const i of ints) {
      const vector = fromBlob(i.embedding);
      const score = Math.max(...c.query.map((q) => cosine(q.vector, vector)));
      if (score >= MIN_SIM && (!best || score > best.score)) best = { userId: u.id, name: u.name, score, label: i.label, vector, reason: `You both like ${i.label}` };
    }
    if (best) out.push(best);
  }
  return out.sort((a, b) => b.score - a.score);
}

const plan = () => planMeetups(NOW, fakeFind);
const like = (v: Float32Array, o = {}) => makeUser({ interests: [{ label: 'frisbee', vector: v, category: 'sport' }], slots: [SLOT], ...o });
const meetups = () => db.prepare('SELECT id, kind, visibility, activity, category FROM meetups ORDER BY id').all() as any[];
const invites = (id: number) => db.prepare('SELECT user_id FROM invitations WHERE meetup_id = ? ORDER BY user_id').all(id).map((r) => r.user_id);

test('4 similar users with a shared slot -> one public group of 4', async () => {
  reset();
  const ids = [0, 1, 2, 3].map(() => like(axis(0)));
  assert.equal(await plan(), 1);
  const [m] = meetups();
  assert.deepEqual([m.kind, m.visibility, m.activity, m.category], ['group', 'public', 'frisbee', 'sport']);
  assert.deepEqual(invites(m.id), ids);
});

test('2 similar users: no group in group mode, a private pair in both mode', async () => {
  reset();
  like(axis(0), { mode: 'group' }); like(axis(0), { mode: 'group' });
  assert.equal(await plan(), 0);
  reset();
  like(axis(0)); like(axis(0));
  assert.equal(await plan(), 1);
  assert.deepEqual(meetups().map((m) => [m.kind, m.visibility]), [['pair', 'private']]);
});

test('a user with a pending invite is not re-invited', async () => {
  reset();
  const ids = [0, 1, 2].map(() => like(axis(0)));
  assert.equal(await plan(), 1);
  const extra = [like(axis(0)), like(axis(0))];
  assert.equal(await plan(), 1); // only the 2 new users pair up
  const [, second] = meetups();
  assert.equal(second.kind, 'pair');
  assert.deepEqual(invites(second.id), extra);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM invitations WHERE user_id = ?').get(ids[0])!.n, 1);
});

test('running twice creates nothing the second time', async () => {
  reset();
  for (let i = 0; i < 5; i++) like(axis(0));
  assert.equal(await plan(), 1);
  assert.equal(await plan(), 0);
  assert.equal(meetups().length, 1);
});

test("an invite on an already-past slot doesn't make a user busy", async () => {
  reset();
  const ids = [0, 1, 2].map(() => like(axis(0)));
  const m = db.prepare("INSERT INTO meetups (kind, activity, category, place_id, slot, min_size, max_size, deadline, visibility, seed_embedding, embedding) VALUES ('pair','x','other','p',?,2,2,?, 'private', x'00', x'00')").run(at(21, 17).toISOString(), at(21, 15).toISOString());
  db.prepare('INSERT INTO invitations (meetup_id, user_id) VALUES (?, ?)').run(m.lastInsertRowid, ids[0]);
  assert.equal(await plan(), 1);
  assert.deepEqual(invites(meetups()[1].id), ids);
});

test('a user with axis(0) and axis(5) interests lands in an axis(5) group', async () => {
  reset();
  const multi = makeUser({ interests: [{ label: 'frisbee', vector: axis(0), category: 'sport' }, { label: 'chess', vector: axis(5), category: 'talk' }], slots: [SLOT] });
  const others = [0, 1, 2].map(() => makeUser({ interests: [{ label: 'chess', vector: axis(5), category: 'talk' }], slots: [SLOT] }));
  assert.equal(await plan(), 1);
  const [m] = meetups();
  assert.deepEqual([m.kind, m.activity, m.category], ['group', 'chess', 'talk']);
  assert.deepEqual(invites(m.id), [multi, ...others]);
});

// An old meetup created at `created`, with each user's invitation in the given state.
const history = (state: string, created: Date, invs: [number, string][]) => {
  const m = db.prepare(
    "INSERT INTO meetups (kind, activity, category, place_id, slot, min_size, max_size, deadline, visibility, seed_embedding, embedding, state, created_at) VALUES ('group','x','sport','p',?,3,6,?,'public',x'00',x'00',?,datetime(?))",
  ).run(at(21, 17).toISOString(), at(21, 15).toISOString(), state, created.toISOString());
  for (const [u, s] of invs) db.prepare('INSERT INTO invitations (meetup_id, user_id, state) VALUES (?, ?, ?)').run(m.lastInsertRowid, u, s);
};

test('cooldown: declined, expired, or on an expired meetup in the last 24h means skipped', async () => {
  reset();
  const ids = [0, 1, 2, 3].map(() => like(axis(0)));
  history('cancelled', at(21, 11), [[ids[0], 'declined'], [ids[1], 'expired']]);
  history('expired', at(21, 11), [[ids[2], 'accepted']]);
  assert.equal(await plan(), 0);
  db.prepare('UPDATE meetups SET created_at = datetime(?)').run(at(21, 9).toISOString());
  assert.equal(await plan(), 1);
  assert.deepEqual(invites(meetups().at(-1).id), ids);
});

test('quiet hours: nothing is planned before 8 AM or from 10 PM', async () => {
  reset();
  [0, 1, 2].map(() => like(axis(0)));
  assert.equal(await planMeetups(at(22, 7, 59), fakeFind), 0);
  assert.equal(await planMeetups(at(21, 22), fakeFind), 0);
  assert.equal(meetups().length, 0);
  assert.equal(await planMeetups(at(22, 8), fakeFind), 1);
});

test('a proposer with no interests is skipped, not a crash', async () => {
  reset();
  makeUser({ slots: [SLOT] });
  const other = like(axis(0));
  const find = (c: Criteria): Candidate[] => (c.excludeUserIds ?? []).includes(other) ? [] : [{ userId: other, name: 'x', score: 1, label: 'frisbee', vector: axis(0), reason: 'r' }];
  assert.equal(await planMeetups(NOW, find), 0);
});
