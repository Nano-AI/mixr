import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db, reset } from '../../src/db.ts';
import { createProposal } from '../../src/meetups/proposals.ts';
import { recordResponse } from '../../src/meetups/responses.ts';
import { listPublicEvents, joinEvent } from '../../src/meetups/events.ts';
import { makeUser, axis, blend } from '../helpers.ts';
import type { ProposalDetails } from '../../src/types.ts';

// Oct 22 2026 is a Thursday. Tests run with TZ=America/Los_Angeles.
const at = (d: number, h: number) => new Date(2026, 9, d, h);
const NOW = at(22, 10);
const SLOT = at(22, 17).toISOString();

beforeEach(reset);

const propose = (o: Partial<ProposalDetails> = {}) =>
  createProposal({ kind: 'group', activity: 'ultimate frisbee', category: 'sport', vector: axis(0), slot: SLOT, userIds: [makeUser(), makeUser(), makeUser()], visibility: 'public', ...o }, NOW);
const viewer = () => makeUser({ interests: [{ label: 'frisbee', vector: axis(0) }, { label: 'chess', vector: axis(9) }] });
const texts = (u: number) => (db.prepare("SELECT text FROM message_jobs WHERE user_id = ? AND dedupe_key LIKE 'events:%' ORDER BY id").all(u) as any[]).map((r) => r.text);
const state = (id: number) => (db.prepare('SELECT state FROM meetups WHERE id = ?').get(id) as any).state;

test('lists only open, future, matching, public meetups, best cosine first, max 3', async () => {
  const u = viewer();
  const best = await propose();
  const close = await propose({ activity: 'pickup soccer', vector: blend(axis(0), axis(1), 0.4) });
  const chess = await propose({ activity: 'chess', category: 'other', vector: blend(axis(9), axis(2), 0.55) });
  await propose({ activity: 'private run', visibility: 'private' });
  await propose({ activity: 'sudoku', vector: axis(5) });
  const full = await propose({ activity: 'full game', userIds: Array.from({ length: 6 }, () => makeUser()) });
  for (const r of db.prepare('SELECT user_id FROM invitations WHERE meetup_id = ?').all(full.id) as any[]) await recordResponse(r.user_id, full.id, 'yes', NOW);
  const past = await propose({ activity: 'old game' });
  db.prepare('UPDATE meetups SET slot = ? WHERE id = ?').run(at(21, 17).toISOString(), past.id);
  await propose({ activity: 'already invited', userIds: [u, makeUser(), makeUser()] });

  await listPublicEvents(u, NOW);
  const [msg, ...rest] = texts(u);
  assert.equal(rest.length, 0);
  const lines = msg.split('\n');
  assert.equal(lines.length, 4);
  assert.equal(lines[0], `${best.id}) ultimate frisbee, Thu 5 PM at Denny Field (0/6)`);
  assert.match(lines[1], new RegExp(`^${close.id}\\) pickup soccer`));
  assert.match(lines[2], new RegExp(`^${chess.id}\\) chess`));
  assert.equal(lines[3], `Reply JOIN ${best.id}`);
});

test('nothing matching sends the fallback', async () => {
  const u = viewer();
  await propose({ vector: axis(5) });
  await listPublicEvents(u, NOW);
  assert.deepEqual(texts(u), ["No open events match your interests right now. I'll text you when one comes up."]);
});

test('joinEvent: private or missing is not_invited and adds no invitation', async () => {
  const u = viewer();
  const m = await propose({ visibility: 'private' });
  assert.deepEqual(await joinEvent(u, m.id, NOW), { outcome: 'not_invited' });
  assert.deepEqual(await joinEvent(u, 9999, NOW), { outcome: 'not_invited' });
  assert.equal((db.prepare('SELECT COUNT(*) c FROM invitations WHERE user_id = ?').get(u) as any).c, 0);
});

test('joinEvent on a public meetup accepts and can confirm', async () => {
  const [a, b] = [makeUser(), makeUser()];
  const m = await propose({ userIds: [a, b] });
  await recordResponse(a, m.id, 'yes', NOW);
  await recordResponse(b, m.id, 'yes', NOW);
  assert.equal(state(m.id), 'proposed');
  const u = viewer();
  assert.equal((await joinEvent(u, m.id, NOW)).outcome, 'confirmed');
  assert.equal(state(m.id), 'confirmed');
  assert.equal((db.prepare('SELECT state FROM invitations WHERE meetup_id = ? AND user_id = ?').get(m.id, u) as any).state, 'accepted');
});

test('7th joiner gets full and the count stays 6', async () => {
  const m = await propose({ userIds: [] });
  for (let i = 0; i < 6; i++) await joinEvent(makeUser(), m.id, NOW);
  assert.equal((await joinEvent(makeUser(), m.id, NOW)).outcome, 'full');
  assert.equal((db.prepare("SELECT COUNT(*) c FROM invitations WHERE meetup_id = ? AND state = 'accepted'").get(m.id) as any).c, 6);
});
