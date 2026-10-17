import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, reset } from '../../src/db.ts';
import { recordFeedback, eloUpdate } from '../../src/meetups/feedback.ts';
import { createProposal } from '../../src/meetups/proposals.ts';
import { makeUser, axis } from '../helpers.ts';

const meetup = async (userIds: number[]) => (await createProposal({
  kind: 'group', activity: 'frisbee', category: 'sport', vector: axis(0),
  slot: new Date(Date.now() + 3 * 86400_000).toISOString(), userIds, visibility: 'public',
})).id;
const ask = (m: number, u: number, created = '2026-01-01 00:00:00') =>
  db.prepare('INSERT INTO feedback (meetup_id, user_id, created_at) VALUES (?, ?, ?)').run(m, u, created);
const rel = (u: number) => (db.prepare('SELECT reliability r FROM users WHERE id = ?').get(u) as { r: number }).r;

test('eloUpdate', () => {
  assert.equal(eloUpdate(1200, true), 1216);
  assert.equal(eloUpdate(1200, false), 1184);
  assert.ok(eloUpdate(1400, false) < 1400 - 16);
});

test('recordFeedback fills the latest outstanding row, updates reliability, thanks once', async () => {
  reset();
  const u = makeUser(), o = makeUser(), p = makeUser();
  const [m1, m2] = [await meetup([u, o, p]), await meetup([u, o, p])];
  ask(m1, u, '2026-01-01 00:00:00');
  ask(m2, u, '2026-01-02 00:00:00');
  assert.equal(await recordFeedback(u, true, 'great'), true);
  const rows = db.prepare('SELECT meetup_id m, attended a, note n FROM feedback ORDER BY meetup_id').all();
  assert.deepEqual(rows.map((r) => ({ ...r })), [{ m: m1, a: null, n: null }, { m: m2, a: 1, n: 'great' }]);
  assert.equal(rel(u), 1216);
  const job = db.prepare('SELECT text FROM message_jobs WHERE dedupe_key = ?').get(`feedback-thanks:${m2}:${u}`) as { text: string };
  assert.equal(job.text, "Thanks! Want another one soon? I'll keep looking.");
  assert.equal(await recordFeedback(u, false, ''), true); // m1 next
  assert.equal(rel(u), eloUpdate(1216, false));
});

test('recordFeedback: same created_at tie-breaks on greatest meetup_id; false when none outstanding', async () => {
  reset();
  const u = makeUser();
  assert.equal(await recordFeedback(u, true, ''), false);
  const [m1, m2] = [await meetup([u]), await meetup([u])];
  ask(m1, u); ask(m2, u);
  await recordFeedback(u, false, 'missed');
  assert.equal((db.prepare('SELECT attended a FROM feedback WHERE meetup_id = ?').get(m2) as { a: number }).a, 0);
  assert.equal(rel(u), 1184);
  assert.equal(await recordFeedback(u, true, ''), true);
  assert.equal(await recordFeedback(u, true, ''), false);
});
