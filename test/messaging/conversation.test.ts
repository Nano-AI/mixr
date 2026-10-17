import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db, reset } from '../../src/db.ts';
import { retryFailed } from '../../src/messaging/send.ts';
import { setTransport } from '../../src/messaging/transport.ts';
import { createRouter } from '../../src/messaging/router.ts';
import type { Profile } from '../../src/types.ts';
beforeEach(() => {
  reset();
  setTransport(async () => {});
});
const phone = '+14253694262';
const profile: Profile = {
  summary: 'Frisbee and philosophy',
  interests: [],
  vibe: '',
  constraints: [],
};
function conversation() {
  let code = '';
  let sequence = 0;
  const extracted: string[] = [];
  const route = createRouter({
    buildProfile: async (_id, text) => {
      extracted.push(text);
      return { ...profile, summary: text };
    },
    confirmProfile: () => {},
    sendCode: async (_email, value) => {
      code = value;
    },
    upcomingSlots: () => [
      '2099-10-20T19:00:00.000Z',
      '2099-10-21T19:00:00.000Z',
    ],
    planMeetups: async () => {},
  });
  return {
    say: (text: string, id = String(++sequence)) =>
      route({ from: phone, text, providerId: id }),
    code: () => code,
    extracted,
  };
}
const user = () => db.prepare('SELECT * FROM users WHERE phone=?').get(phone)!;
test('onboarding requires consent and email verification, accepts corrections and saves selected availability', async () => {
  const c = conversation();
  await c.say('hello');
  assert.equal(user().step, 'consent');
  await c.say('maybe');
  assert.equal(user().step, 'consent');
  await c.say('YES');
  await c.say('Ana');
  await c.say('ana@gmail.com');
  assert.equal(user().step, 'email');
  await c.say('ana@uw.edu');
  assert.equal(user().step, 'verify');
  await c.say('000000' === c.code() ? '111111' : '000000');
  assert.equal(user().email_verified, 0);
  await c.say(c.code());
  assert.equal(user().email_verified, 1);
  await c.say('frisbee');
  assert.equal(user().step, 'braindump');
  await c.say('PROFILE');
  await c.say('also philosophy');
  assert.match(c.extracted.at(-1)!, /frisbee.*\nCorrection: also philosophy/);
  await c.say('YES');
  assert.equal(user().step, 'active');
  assert.equal(db.prepare('SELECT count(*) AS n FROM availability').get()!.n, 0);
  await c.say('FREE');
  assert.equal(user().step, 'availability');
  await c.say('1 99');
  assert.equal(user().step, 'availability');
  await c.say('1 2');
  assert.equal(user().step, 'active');
  assert.equal(
    db.prepare('SELECT count(*) AS n FROM availability').get()!.n,
    2,
  );
  assert.equal(
    db.prepare('SELECT confirmed FROM profiles').get()!.confirmed,
    1,
  );
});
test('duplicate inbound does not advance conversation and STOP silences subsequent messages', async () => {
  const c = conversation();
  await c.say('hello', 'same');
  await c.say('hello', 'same');
  assert.equal(
    db.prepare('SELECT count(*) AS n FROM inbound_messages').get()!.n,
    1,
  );
  assert.equal(
    db.prepare('SELECT count(*) AS n FROM message_jobs').get()!.n,
    1,
  );
  await c.say('STOP');
  const count = db.prepare('SELECT count(*) AS n FROM message_jobs').get()!.n;
  await c.say('hello');
  assert.equal(
    db.prepare('SELECT count(*) AS n FROM message_jobs').get()!.n,
    count,
  );
  assert.equal(user().opted_out, 1);
  await c.say('START');
  assert.equal(user().opted_out, 0);
});
test('ambiguous YES never accepts a seat; explicit reply routes to the selected invitation', async () => {
  const calls: unknown[] = [];
  const route = createRouter({
    openInvitations: () => [12, 15],
    recordResponse: async (...args) => {
      calls.push(args);
      return { outcome: 'accepted' };
    },
  });
  db.prepare(
    "INSERT INTO users(phone,step,email_verified) VALUES (?,'active',1)",
  ).run(phone);
  await route({ from: phone, text: 'yes', providerId: '1' });
  assert.equal(calls.length, 0);
  assert.match(
    String(db.prepare('SELECT text FROM message_jobs').get()!.text),
    /YES 12.*YES 15/,
  );
  await route({ from: phone, text: 'Yes 12!', providerId: '2' });
  assert.deepEqual(calls[0], [Number(user().id), 12, 'yes']);
});
test('three wrong codes return to email collection; unavailable email delivery never verifies', async () => {
  const c = conversation();
  for (const text of ['hi', 'YES', 'Ana', 'ana@uw.edu']) await c.say(text);
  for (let i = 0; i < 3; i++)
    await c.say(c.code() === '000000' ? '111111' : '000000');
  assert.equal(user().step, 'email');
  assert.equal(user().email_verified, 0);
  const route = createRouter({
    sendCode: async () => {
      throw Error('offline');
    },
  });
  await route({ from: phone, text: 'ana@uw.edu', providerId: 'failed-email' });
  assert.equal(user().step, 'email');
  assert.equal(user().email_verified, 0);
});
test('completed students can cancel existing invites while editing availability', async () => {
  const c = conversation();
  for (const t of ['hi', 'YES', 'Ana', 'ana@uw.edu']) await c.say(t);
  await c.say(c.code());
  for (const t of ['frisbee', 'PROFILE', 'OK', 'FREE']) await c.say(t);
  let cancelled = false;
  const route = createRouter({
    recordResponse: async () => {
      cancelled = true;
      return { outcome: 'cancelled' };
    },
  });
  await route({ from: phone, text: 'CANCEL 12', providerId: 'cancel-edit' });
  assert.equal(cancelled, true);
  assert.equal(user().step, 'availability');
});
test('verification codes are not retained as plaintext in inbound storage', async () => {
  const c = conversation();
  for (const t of ['hi', 'YES', 'Ana', 'ana@uw.edu']) await c.say(t);
  await c.say(c.code(), 'code-message');
  assert.notEqual(
    db
      .prepare(
        "SELECT text FROM inbound_messages WHERE provider_id='code-message'",
      )
      .get()!.text,
    c.code(),
  );
});
test('STOP retires queued invitations so START cannot send stale invitations', async () => {
  const c = conversation();
  await c.say('hi');
  db.prepare(
    "INSERT INTO message_jobs(user_id,dedupe_key,text,status) VALUES (?,'old-invite','old invitation','failed')",
  ).run(Number(user().id));
  await c.say('STOP');
  await c.say('START');
  const row = db
    .prepare(
      "SELECT attempts,error FROM message_jobs WHERE dedupe_key='old-invite'",
    )
    .get()!;
  assert.equal(row.attempts, 0);
  assert.match(String(row.error), /STOP/);
  let sent = 0;
  setTransport(async () => {
    sent++;
  });
  await retryFailed();
  assert.equal(sent, 0);
});
