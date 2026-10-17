import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db, fromBlob, reset } from '../../src/db.ts';
import { createProposal } from '../../src/meetups/proposals.ts';
import { recordResponse, openInvitations } from '../../src/meetups/responses.ts';
import { tick } from '../../src/meetups/scheduler.ts';
import { cosine } from '../../src/matching/vectors.ts';
import { placeOf } from '../../src/meetups/places.ts';
import { makeUser, axis } from '../helpers.ts';
import type { ProposalDetails } from '../../src/types.ts';

// Oct 22 2026 is a Thursday. Tests run with TZ=America/Los_Angeles.
const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m);
const NOW = at(22, 10);
const SLOT = at(22, 17).toISOString();

beforeEach(reset);

async function setup(n = 4, o: Partial<ProposalDetails> = {}) {
  const userIds = Array.from({ length: n }, () => makeUser());
  const m = await createProposal({ kind: 'group', activity: 'ultimate frisbee', category: 'sport', vector: axis(0), slot: SLOT, userIds, visibility: 'public', ...o }, NOW);
  return { m, userIds };
}
const inv = (id: number, u: number) => (db.prepare('SELECT * FROM invitations WHERE meetup_id = ? AND user_id = ?').get(id, u) as any);
const meetup = (id: number) => db.prepare('SELECT * FROM meetups WHERE id = ?').get(id) as any;
const jobs = (like: string) => db.prepare('SELECT * FROM message_jobs WHERE dedupe_key LIKE ?').all(like) as any[];
const count = (id: number, state: string) => (db.prepare('SELECT COUNT(*) c FROM invitations WHERE meetup_id = ? AND state = ?').get(id, state) as any).c;
const CLOSED = "That one closed. I'll find you another.";
const reply = (tag: string, id: number, u: number, when = NOW) => jobs(`reply:${tag}:${id}:${u}:${when.getTime()}`)[0]?.text;

test('3 of 4 yes confirms and sends one confirm job per accepted user', async () => {
  const { m, userIds } = await setup();
  assert.equal((await recordResponse(userIds[0], m.id, 'yes', NOW)).outcome, 'accepted');
  assert.equal((await recordResponse(userIds[1], m.id, 'yes', NOW)).outcome, 'accepted');
  assert.equal((await recordResponse(userIds[2], m.id, 'yes', NOW)).outcome, 'confirmed');
  assert.equal(meetup(m.id).state, 'confirmed');
  for (const u of userIds.slice(0, 3)) assert.equal(jobs(`confirm:${m.id}:${u}:%`).length, 1);
  assert.equal(jobs(`confirm:${m.id}:${userIds[3]}:%`).length, 0);
  assert.match(jobs(`confirm:${m.id}:${userIds[0]}:%`)[0].text, /^Confirmed: ultimate frisbee, Thu 5 PM at Denny Field\. Meet at the field entrance off Stevens Way\. Going: User\d+, User\d+, User\d+\. CANCEL \d+ if plans change\.$/);
});

test('2 of 4 yes stays proposed', async () => {
  const { m, userIds } = await setup();
  await recordResponse(userIds[0], m.id, 'yes', NOW);
  await recordResponse(userIds[1], m.id, 'yes', NOW);
  assert.equal(meetup(m.id).state, 'proposed');
  assert.match(jobs(`%${m.id}:${userIds[1]}%`).at(-1).text, /^You're in\. I'll confirm once 1 more say yes\.$/);
});

test('yes at max_size is full and the count stays', async () => {
  const { m, userIds } = await setup(7);
  for (const u of userIds.slice(0, 6)) await recordResponse(u, m.id, 'yes', NOW);
  assert.equal((await recordResponse(userIds[6], m.id, 'yes', NOW)).outcome, 'full');
  assert.equal(inv(m.id, userIds[6]).state, 'full');
  assert.equal(count(m.id, 'accepted'), 6);
  assert.equal((await recordResponse(userIds[6], m.id, 'yes', at(22, 11))).outcome, 'closed');
  assert.equal(reply('closed', m.id, userIds[6], at(22, 11)), CLOSED);
});

test('two YES replies racing for the last seat: one gets in, one is full', async () => {
  const { m, userIds } = await setup(7);
  for (const u of userIds.slice(0, 5)) await recordResponse(u, m.id, 'yes', NOW);
  const outs = (await Promise.all(userIds.slice(5).map((u) => recordResponse(u, m.id, 'yes', NOW)))).map((r) => r.outcome);
  assert.equal(outs.filter((o) => o === 'confirmed' || o === 'accepted').length, 1);
  assert.equal(outs.filter((o) => o === 'full').length, 1);
  assert.equal(count(m.id, 'accepted'), meetup(m.id).max_size);
});

test('same user yes twice is a no-op', async () => {
  const { m, userIds } = await setup();
  for (const u of userIds.slice(0, 3)) await recordResponse(u, m.id, 'yes', NOW);
  const before = db.prepare('SELECT COUNT(*) c FROM message_jobs').get() as any;
  await recordResponse(userIds[0], m.id, 'yes', NOW);
  assert.deepEqual(db.prepare('SELECT COUNT(*) c FROM message_jobs').get(), before);
  assert.equal(jobs(`confirm:${m.id}:${userIds[0]}:%`).length, 1);
});

test('yes after the deadline or on a cancelled meetup is closed', async () => {
  const { m, userIds } = await setup();
  const r = await recordResponse(userIds[0], m.id, 'yes', at(22, 15, 30));
  assert.equal(r.outcome, 'closed');
  assert.equal(inv(m.id, userIds[0]).state, 'pending');
  assert.equal(jobs(`%${m.id}:${userIds[0]}%`).at(-1).text, "That one closed. I'll find you another.");
  db.prepare("UPDATE meetups SET state = 'cancelled' WHERE id = ?").run(m.id);
  assert.equal((await recordResponse(userIds[1], m.id, 'yes', NOW)).outcome, 'closed');
});

test('not invited, pass', async () => {
  const { m, userIds } = await setup();
  assert.equal((await recordResponse(makeUser(), m.id, 'yes', NOW)).outcome, 'not_invited');
  assert.equal((await recordResponse(userIds[0], m.id, 'pass', NOW)).outcome, 'declined');
  assert.equal(inv(m.id, userIds[0]).state, 'declined');
});

test('every reply gets an answer: cancel/pass on accepted, yes after pass, cancel on pending or declined', async () => {
  const { m, userIds } = await setup(4);
  const [a, b, c, d] = userIds;
  const T = at(22, 10, 5);
  await recordResponse(a, m.id, 'yes', NOW);
  assert.equal((await recordResponse(a, m.id, 'cancel', T)).outcome, 'cancelled');
  assert.equal(reply('cancel', m.id, a, T), "Got it, you're out of ultimate frisbee.");
  await recordResponse(b, m.id, 'yes', NOW);
  assert.equal((await recordResponse(b, m.id, 'pass', T)).outcome, 'cancelled');
  assert.equal(inv(m.id, b).state, 'cancelled');
  assert.equal(reply('cancel', m.id, b, T), "Got it, you're out of ultimate frisbee.");
  await recordResponse(c, m.id, 'pass', NOW);
  assert.equal((await recordResponse(c, m.id, 'yes', T)).outcome, 'closed');
  assert.equal(reply('closed', m.id, c, T), CLOSED);
  assert.equal((await recordResponse(c, m.id, 'cancel', at(22, 10, 6))).outcome, 'closed');
  assert.equal(reply('closed', m.id, c, at(22, 10, 6)), CLOSED);
  assert.equal((await recordResponse(d, m.id, 'cancel', T)).outcome, 'closed');
  assert.equal(inv(m.id, d).state, 'pending');
  assert.equal(reply('closed', m.id, d, T), CLOSED);
});

async function confirmed() {
  const s = await setup(3);
  for (const u of s.userIds) await recordResponse(u, s.m.id, 'yes', NOW);
  return s;
}

test('cancel below min more than 2h out reopens and backfills one', async () => {
  const { m, userIds } = await confirmed();
  const spare = makeUser();
  assert.equal((await recordResponse(userIds[0], m.id, 'cancel', at(22, 12))).outcome, 'cancelled');
  assert.equal(meetup(m.id).state, 'proposed');
  assert.equal(count(m.id, 'pending'), 1);
  assert.equal(inv(m.id, spare).state, 'pending');
  assert.equal(jobs(`joined:%`).length, 0);
  assert.match(jobs(`cancel:${m.id}:%:${userIds[1]}`)[0].text, /^User\d+ can't make it\.$/);
  assert.ok(new Date(meetup(m.id).deadline) > at(22, 12));
});

test('cancel below min less than 2h out cancels the meetup', async () => {
  const { m, userIds } = await confirmed();
  await recordResponse(userIds[0], m.id, 'cancel', at(22, 16));
  assert.equal(meetup(m.id).state, 'cancelled');
  for (const u of userIds.slice(1)) assert.match(jobs(`%${m.id}:${u}`).at(-1).text, /^Not enough people for ultimate frisbee anymore, so it's off\. I'll find you another\.$/);
});

test('joining a confirmed meetup confirms the joiner and tells the others', async () => {
  const { m, userIds } = await setup(4);
  for (const u of userIds.slice(0, 3)) await recordResponse(u, m.id, 'yes', NOW);
  await recordResponse(userIds[3], m.id, 'yes', NOW);
  assert.equal(jobs(`confirm:${m.id}:${userIds[3]}:%`).length, 1);
  assert.equal(jobs(`joined:${m.id}:${userIds[3]}:${userIds[0]}`).length, 1);
});

test('bias moves the meetup embedding toward accepted members', async () => {
  const members = [makeUser({ interests: [{ label: 'chess', vector: axis(1) }] }), makeUser({ interests: [{ label: 'chess', vector: axis(1) }] }), makeUser()];
  const m = await createProposal({ kind: 'group', activity: 'x', category: 'other', vector: axis(0), slot: SLOT, userIds: members, visibility: 'public' }, NOW);
  await recordResponse(members[0], m.id, 'yes', NOW);
  const e = fromBlob(meetup(m.id).embedding);
  assert.ok(cosine(e, axis(1)) > 0);
  assert.ok(cosine(e, axis(0)) > 0);
});

test('openInvitations', async () => {
  const { m, userIds } = await setup();
  await recordResponse(userIds[0], m.id, 'yes', NOW);
  assert.deepEqual(openInvitations(userIds[0], 'yes', NOW), []);
  assert.deepEqual(openInvitations(userIds[0], 'cancel', NOW), [m.id]);
  assert.deepEqual(openInvitations(userIds[1], 'yes', NOW), [m.id]);
  assert.deepEqual(openInvitations(userIds[1], 'pass', NOW), [m.id]);
});

test('openInvitations skips started, done, expired and cancelled meetups', async () => {
  const { m, userIds } = await setup();
  await recordResponse(userIds[0], m.id, 'yes', NOW);
  const set = (state: string) => db.prepare('UPDATE meetups SET state = ? WHERE id = ?').run(state, m.id);
  assert.deepEqual(openInvitations(userIds[0], 'cancel', at(22, 17)), []);
  assert.deepEqual(openInvitations(userIds[1], 'yes', at(22, 17)), []);
  for (const state of ['done', 'expired', 'cancelled']) {
    set(state);
    assert.deepEqual(openInvitations(userIds[0], 'cancel', NOW), [], state);
    assert.deepEqual(openInvitations(userIds[1], 'yes', NOW), [], state);
  }
});

test('after the slot starts YES is closed and changes nothing', async () => {
  const { m, userIds } = await setup(4);
  for (const u of userIds.slice(0, 3)) await recordResponse(u, m.id, 'yes', NOW);
  assert.equal((await recordResponse(userIds[3], m.id, 'yes', at(22, 17))).outcome, 'closed');
  assert.equal(inv(m.id, userIds[3]).state, 'pending');
  assert.equal(reply('closed', m.id, userIds[3], at(22, 17)), CLOSED);
});

test('CANCEL after the slot starts only releases the seat; the meetup still ends with feedback', async () => {
  const { m, userIds } = await confirmed();
  const t = at(22, 17, 30);
  assert.equal((await recordResponse(userIds[0], m.id, 'cancel', t)).outcome, 'cancelled');
  assert.equal(inv(m.id, userIds[0]).state, 'cancelled');
  assert.equal(meetup(m.id).state, 'confirmed');
  assert.equal(jobs('cancel:%').length + jobs('off:%').length, 0);
  assert.equal(reply('cancel', m.id, userIds[0], t), "Got it, you're out of ultimate frisbee.");
  await tick(at(22, 19), async () => 0);
  assert.equal(meetup(m.id).state, 'done');
  assert.deepEqual(db.prepare('SELECT user_id FROM feedback WHERE meetup_id = ? ORDER BY user_id').all(m.id).map((r: any) => r.user_id), userIds.slice(1));
});

test('location votes: majority place wins at confirmation', async () => {
  const { m, userIds } = await setup(3, { category: 'talk' });
  await recordResponse(userIds[0], m.id, 'yes', NOW, 'cafe allegro');
  assert.match(jobs(`%${m.id}:${userIds[0]}%`).at(-1).text, /Noted your vote for Cafe Allegro\./);
  await recordResponse(userIds[1], m.id, 'yes', NOW, 'allegro please');
  await recordResponse(userIds[2], m.id, 'yes', NOW);
  assert.equal(meetup(m.id).place_id, 'cafe-allegro');
  assert.match(jobs(`confirm:${m.id}:${userIds[0]}:%`)[0].text, /at Cafe Allegro\. Meet at the alley entrance off the Ave\./);
});

test('unrecognized suggestion is accepted but stores nothing', async () => {
  const { m, userIds } = await setup(3);
  const place = meetup(m.id).place_id;
  await recordResponse(userIds[0], m.id, 'yes', NOW, 'the moon');
  assert.equal(inv(m.id, userIds[0]).state, 'accepted');
  assert.equal(inv(m.id, userIds[0]).place_suggestion, null);
  assert.equal(meetup(m.id).place_id, place);
  assert.equal(jobs(`%${m.id}:${userIds[0]}%`).at(-1).text, "You're in. I'll confirm once 2 more say yes.");
});

test('suggestion on a confirmed meetup is ignored', async () => {
  const { m, userIds } = await setup(4);
  const place = meetup(m.id).place_id;
  for (const u of userIds.slice(0, 3)) await recordResponse(u, m.id, 'yes', NOW);
  await recordResponse(userIds[3], m.id, 'yes', NOW, 'cafe allegro');
  assert.equal(meetup(m.id).place_id, place);
  assert.equal(inv(m.id, userIds[3]).place_suggestion, null);
});

test('re-confirmation after a reopen reaches old and new members', async () => {
  const { m, userIds } = await confirmed();
  const spare = makeUser();
  await recordResponse(userIds[0], m.id, 'cancel', at(22, 12));
  await recordResponse(spare, m.id, 'yes', at(22, 12, 30));
  assert.equal(meetup(m.id).state, 'confirmed');
  for (const u of [userIds[1], userIds[2], spare]) {
    const sent = jobs(`confirm:${m.id}:${u}:%`);
    assert.equal(sent.length, u === spare ? 1 : 2);
    assert.match(sent.at(-1).text, new RegExp(`Going: .*User${spare}`.replace(/User(\d+)/, (_, n) => (db.prepare('SELECT name FROM users WHERE id = ?').get(spare) as any).name)));
  }
});

test('a reopened meetup keeps the place it first confirmed at', async () => {
  const { m, userIds } = await setup(3, { category: 'talk' });
  for (const u of userIds) await recordResponse(u, m.id, 'yes', NOW);
  const place = meetup(m.id).place_id;
  const spare = makeUser();
  await recordResponse(userIds[0], m.id, 'cancel', at(22, 12));
  await recordResponse(spare, m.id, 'yes', at(22, 12, 30), 'cafe allegro');
  assert.equal(meetup(m.id).state, 'confirmed');
  assert.equal(meetup(m.id).place_id, place);
  assert.match(jobs(`confirm:${m.id}:${spare}:%`)[0].text, new RegExp(`at ${placeOf(place).name}\\.`));
});

test('cancel on a proposed meetup below min re-evaluates and backfills', async () => {
  const { m, userIds } = await setup(3);
  const spare = makeUser();
  await recordResponse(userIds[0], m.id, 'yes', NOW);
  await recordResponse(userIds[0], m.id, 'cancel', at(22, 12));
  assert.equal(meetup(m.id).state, 'proposed');
  assert.equal(inv(m.id, spare).state, 'pending');
});
