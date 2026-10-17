import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db, reset } from '../../src/db.ts';
import { makeUser } from '../helpers.ts';
import { sendMessage, retryFailed } from '../../src/messaging/send.ts';
import { setTransport } from '../../src/messaging/transport.ts';
beforeEach(reset);
test('outbox deduplicates sends and records failures for bounded retry', async () => {
  const id = makeUser();
  let calls = 0;
  setTransport(async () => {
    calls++;
    throw new Error('delivery unavailable');
  });
  assert.equal(await sendMessage(id, 'invite', 'invite:1'), 'failed');
  assert.equal(await sendMessage(id, 'invite', 'invite:1'), 'duplicate');
  assert.equal(calls, 1);
  assert.equal(
    db.prepare('SELECT status FROM message_jobs').get()!.status,
    'failed',
  );
  await retryFailed();
  await retryFailed();
  await retryFailed();
  assert.equal(calls, 3);
});
test('STOP suppresses queued retries but allows its acknowledgement', async () => {
  const id = makeUser();
  let calls = 0;
  setTransport(async () => {
    throw Error('offline');
  });
  await sendMessage(id, 'invite', 'invite:1');
  db.prepare('UPDATE users SET opted_out=1 WHERE id=?').run(id);
  setTransport(async () => {
    calls++;
  });
  await retryFailed();
  assert.equal(await sendMessage(id, 'reminder', 'reminder:1'), 'opted_out');
  assert.equal(calls, 0);
  assert.equal(await sendMessage(id, 'unsubscribed', 'stop-ack:1'), 'sent');
  assert.equal(calls, 1);
});
test('stopped-user backlog cannot starve active-user delivery', async () => {
  const stopped = makeUser();
  const active = makeUser();
  db.prepare('UPDATE users SET opted_out=1 WHERE id=?').run(stopped);
  for (let i = 0; i < 100; i++)
    db.prepare(
      "INSERT INTO message_jobs(user_id,dedupe_key,text,status) VALUES (?,?,'old','failed')",
    ).run(stopped, `old:${i}`);
  db.prepare(
    "INSERT INTO message_jobs(user_id,dedupe_key,text,status) VALUES (?,'new','invite','failed')",
  ).run(active);
  setTransport(async () => {});
  assert.equal(await retryFailed(), 1);
  assert.equal(
    db.prepare("SELECT status FROM message_jobs WHERE dedupe_key='new'").get()!
      .status,
    'sent',
  );
});
