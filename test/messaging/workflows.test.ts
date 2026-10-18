import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { db, reset } from '../../src/db.ts';
import { createRouter } from '../../src/messaging/router.ts';
import { setTransport } from '../../src/messaging/transport.ts';
import { createProposal } from '../../src/meetups/proposals.ts';
import { makeUser, axis } from '../helpers.ts';

const phone = '+14253694262';
beforeEach(() => { reset(); setTransport(async () => {}); });
function student() {
  const id = makeUser({ phone, interests: [{ label: 'frisbee', vector: axis(0), category: 'sport' }] });
  db.prepare('UPDATE users SET email_verified=1 WHERE id=?').run(id);
  return id;
}
function proposal(userIds: number[] = [], visibility: 'public' | 'private' = 'public') {
  return createProposal({ kind: 'group', activity: 'frisbee', category: 'sport', vector: axis(0),
    slot: new Date(Date.now() + 3 * 86400_000).toISOString(), userIds, visibility });
}
const jobs = (id: number) => db.prepare('SELECT * FROM message_jobs WHERE user_id=? ORDER BY id').all(id);

for (const [command, attended, rating] of [['wEnT', 1, 1216], ['MISSED', 0, 1184]] as const) {
  test(`${command} records feedback through the real meetup service; duplicate input cannot consume another request`, async () => {
    const id = student();
    const older = await proposal(), latest = await proposal();
    for (const m of [older, latest]) db.prepare('INSERT INTO feedback(meetup_id,user_id) VALUES (?,?)').run(m.id, id);
    const route = createRouter();
    const message = { from: phone, text: `  ${command}  Great people! `, providerId: 'feedback' };
    await route(message);
    await route(message);
    const row = db.prepare('SELECT attended,note FROM feedback WHERE meetup_id=? AND user_id=?').get(latest.id, id)!;
    assert.equal(row.attended, attended);
    assert.equal(row.note, 'Great people!');
    assert.equal(db.prepare('SELECT attended FROM feedback WHERE meetup_id=?').get(older.id)!.attended, null);
    assert.equal(db.prepare('SELECT reliability FROM users WHERE id=?').get(id)!.reliability, rating);
    assert.equal(jobs(id).length, 1);
  });
}
test('feedback with no outstanding request gets an explanation', async () => {
  const id = student();
  await createRouter()({ from: phone, text: 'WENT', providerId: 'none' });
  assert.match(String(jobs(id)[0].text), /no.*feedback/i);
  assert.equal(db.prepare('SELECT reliability FROM users WHERE id=?').get(id)!.reliability, 1200);
});
test('EVENTS sends a matching public event once with the inbound reply dedupe key', async () => {
  const id = student();
  const m = await proposal();
  const route = createRouter();
  const message = { from: phone, text: 'events!', providerId: 'events' };
  await route(message); await route(message);
  assert.equal(jobs(id).length, 1);
  assert.match(String(jobs(id)[0].text), new RegExp(`JOIN ${m.id}`));
  assert.equal(jobs(id)[0].dedupe_key, 'reply:events');
});
test('JOIN accepts a public event and delivers only the meetup service response', async () => {
  const id = student(); const m = await proposal();
  const route = createRouter();
  const message = { from: phone, text: `join ${m.id}!`, providerId: 'join' };
  await route(message); await route(message);
  assert.equal(db.prepare('SELECT state FROM invitations WHERE meetup_id=? AND user_id=?').get(m.id, id)?.state, 'accepted');
  assert.equal(jobs(id).length, 1);
  assert.match(String(jobs(id)[0].text), /confirm/i);
});
test('JOIN rejects malformed IDs and private or missing events without creating an invitation', async () => {
  const id = student(); const m = await proposal([], 'private'); const route = createRouter();
  for (const [i, text] of ['JOIN', 'JOIN 0', 'JOIN 1.5', 'JOIN 9007199254740993', `JOIN ${m.id}`, 'JOIN 99999'].entries()) {
    await route({ from: phone, text, providerId: `bad-${i}` });
  }
  assert.equal(db.prepare('SELECT count(*) n FROM invitations WHERE user_id=?').get(id)!.n, 0);
  assert.equal(jobs(id).length, 6);
  assert.match(String(jobs(id)[0].text), /JOIN.*number/i);
  assert.match(String(jobs(id).at(-1)!.text), /not.*(available|public)|cannot.*join/i);
});
test('new workflow commands require completed, verified onboarding and respect STOP', async () => {
  const id = student(); const m = await proposal();
  db.prepare('INSERT INTO feedback(meetup_id,user_id) VALUES (?,?)').run(m.id, id);
  db.prepare("UPDATE users SET step='email',email_verified=0 WHERE id=?").run(id);
  const route = createRouter();
  for (const [i, text] of ['EVENTS', `JOIN ${m.id}`, 'WENT', 'MISSED'].entries()) {
    await route({ from: phone, text, providerId: `unverified-${i}` });
  }
  assert.equal(db.prepare('SELECT state FROM invitations WHERE user_id=?').get(id), undefined);
  assert.equal(db.prepare('SELECT attended FROM feedback WHERE user_id=?').get(id)!.attended, null);
  assert.ok(jobs(id).every(j => /onboarding|verify/i.test(String(j.text))));
  db.prepare("UPDATE users SET step='active',email_verified=1,opted_out=1 WHERE id=?").run(id);
  const count = jobs(id).length;
  for (const [i, text] of ['EVENTS', `JOIN ${m.id}`, 'WENT'].entries()) {
    await route({ from: phone, text, providerId: `stopped-${i}` });
  }
  assert.equal(jobs(id).length, count);
  assert.equal(db.prepare('SELECT attended FROM feedback WHERE user_id=?').get(id)!.attended, null);
});
test('YES forwards a suggested place and does not add a second generic acknowledgement', async () => {
  const id = student(); const m = await proposal([id, makeUser(), makeUser()]);
  const before = jobs(id).length;
  await createRouter()({ from: phone, text: `YES ${m.id} + Odegaard!`, providerId: 'spot' });
  const row = db.prepare('SELECT state,place_suggestion FROM invitations WHERE user_id=? AND meetup_id=?').get(id, m.id)!;
  assert.equal(row.state, 'accepted');
  assert.equal(row.place_suggestion, 'odegaard');
  assert.equal(jobs(id).length - before, 1);
});
test('plain YES uses the lifecycle acknowledgement without sending a second generic reply', async () => {
  const id = student(); const m = await proposal([id, makeUser()]); const before = jobs(id).length;
  await createRouter()({ from: phone, text: `YES ${m.id}`, providerId: 'yes' });
  assert.equal(db.prepare('SELECT state FROM invitations WHERE user_id=? AND meetup_id=?').get(id, m.id)!.state, 'accepted');
  assert.equal(jobs(id).length - before, 1);
});
