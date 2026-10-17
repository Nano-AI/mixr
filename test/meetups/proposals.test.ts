import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, fromBlob, reset } from '../../src/db.ts';
import { upcomingSlots, formatSlot } from '../../src/meetups/slots.ts';
import { PLACES, pickPlace, findPlace } from '../../src/meetups/places.ts';
import { createProposal } from '../../src/meetups/proposals.ts';
import { makeUser, axis } from '../helpers.ts';
import type { ProposalDetails } from '../../src/types.ts';

// Oct 22 2026 is a Thursday. Tests run with TZ=America/Los_Angeles.
const at = (d: number, h: number) => new Date(2026, 9, d, h);
const THU_10 = at(22, 10);

const details = (o: Partial<ProposalDetails> = {}): ProposalDetails => ({
  kind: 'group', activity: 'ultimate frisbee', category: 'sport', vector: axis(0),
  slot: at(22, 17).toISOString(), userIds: [makeUser(), makeUser(), makeUser()], visibility: 'public', ...o,
});

test('upcomingSlots: next 6 weekday noon/5pm slots at least 4h out', () => {
  assert.deepEqual(upcomingSlots(THU_10), [at(22, 17), at(23, 12), at(23, 17), at(26, 12), at(26, 17), at(27, 12)].map((d) => d.toISOString()));
});

test('formatSlot', () => {
  assert.equal(formatSlot(at(22, 17).toISOString()), 'Thu 5 PM');
  assert.equal(formatSlot(at(23, 12).toISOString()), 'Fri 12 PM');
});

test('PLACES: unique ids, every category has a place', () => {
  assert.equal(new Set(PLACES.map((p) => p.id)).size, PLACES.length);
  for (const c of ['sport', 'talk', 'other'] as const) assert.ok(PLACES.some((p) => p.categories.includes(c)), c);
});

test('findPlace matches names and aliases, case-insensitive', () => {
  assert.equal(findPlace('cafe allegro')?.id, 'cafe-allegro');
  assert.equal(findPlace('the CSE2 atrium')?.id, 'gates-center');
  assert.equal(findPlace('the moon'), undefined);
  assert.equal(findPlace('animal crossing'), undefined); // 'ima' must not match inside a word
});

test('pickPlace avoids a place already used in the same slot', async () => {
  reset();
  const slot = at(22, 17).toISOString();
  const first = pickPlace('sport', slot);
  await createProposal(details({ slot }), THU_10);
  const second = pickPlace('sport', slot);
  assert.notEqual(second, first);
  assert.equal(pickPlace('sport', at(23, 12).toISOString()), first);
});

test('createProposal: group is 3-6, pair is 2-2', async () => {
  reset();
  const g = await createProposal(details(), THU_10);
  assert.deepEqual([g.minSize, g.maxSize, g.state], [3, 6, 'proposed']);
  const p = await createProposal(details({ kind: 'pair', userIds: [makeUser(), makeUser()], visibility: 'private' }), THU_10);
  assert.deepEqual([p.minSize, p.maxSize], [2, 2]);
});

test('createProposal: deadline is min(now + 6h, slot - 2h)', async () => {
  reset();
  const soon = await createProposal(details(), THU_10); // slot Thu 5 PM -> 3 PM beats 4 PM
  assert.equal(soon.deadline, at(22, 15).toISOString());
  const later = await createProposal(details({ slot: at(23, 12).toISOString() }), THU_10);
  assert.equal(later.deadline, at(22, 16).toISOString());
});

test('createProposal: one pending invite and one invite message per user', async () => {
  reset();
  const d = details();
  const m = await createProposal(d, THU_10);
  const invites = db.prepare("SELECT user_id FROM invitations WHERE meetup_id = ? AND state = 'pending' ORDER BY user_id").all(m.id).map((r) => r.user_id);
  assert.deepEqual(invites, d.userIds);
  const jobs = db.prepare('SELECT dedupe_key AS k, text FROM message_jobs ORDER BY id').all() as { k: string; text: string }[];
  assert.deepEqual(jobs.map((j) => j.k), d.userIds.map((u) => `invite:${m.id}:${u}`));
  const place = PLACES.find((p) => p.id === m.placeId)!;
  for (const s of ['ultimate frisbee', place.name, 'Thu 5 PM', '3:00 PM', `YES ${m.id}`, `PASS ${m.id}`]) assert.ok(jobs[0].text.includes(s), `missing "${s}" in: ${jobs[0].text}`);
});

test('createProposal: embedding starts equal to seed_embedding', async () => {
  reset();
  const m = await createProposal(details(), THU_10);
  const row = db.prepare('SELECT seed_embedding s, embedding e FROM meetups WHERE id = ?').get(m.id)!;
  assert.deepEqual(fromBlob(row.e as Uint8Array), fromBlob(row.s as Uint8Array));
  assert.deepEqual(fromBlob(row.s as Uint8Array), axis(0));
});

test('createProposal: refuses a slot less than 2h away', async () => {
  reset();
  await assert.rejects(createProposal(details({ slot: at(22, 12).toISOString() }), THU_10));
});
