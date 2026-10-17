import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { db, reset } from '../../src/db.ts';
import { makeUser } from '../helpers.ts';
import { createServer } from '../../src/messaging/http.ts';
import { consent } from '../../src/messaging/onboarding.ts';
import { setTransport } from '../../src/messaging/transport.ts';

const server = createServer(() => true, 'test-admin-token');
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
after(() => server.close());
let sent: string[] = [];
let ip = 0;
beforeEach(() => {
  reset();
  sent = [];
  ip++;
  setTransport(async (phone, text) => {
    sent.push(`${phone} ${text}`);
  });
});
const join = (body: unknown, from = `10.0.0.${ip}`) =>
  fetch(base + '/join', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': from },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
const jobs = () => db.prepare('SELECT dedupe_key FROM message_jobs').all();

test('join texts consent once to a new number', async () => {
  const res = await join({ phone: '(425) 555-0100' });
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(
    db.prepare("SELECT step FROM users WHERE phone='+14255550100'").get()!.step,
    'consent',
  );
  assert.deepEqual(
    jobs().map((j) => j.dedupe_key),
    ['join:+14255550100'],
  );
  assert.deepEqual(sent, [`+14255550100 ${consent}`]);
  assert.equal((await join({ phone: '1-425-555-0100' })).status, 202);
  assert.equal(jobs().length, 1);
  assert.equal(sent.length, 1);
});
test('join rejects bad input', async () => {
  for (const body of [
    { phone: '555-0100' },
    { phone: 42 },
    {},
    'not json',
    { phone: '2' + '0'.repeat(10) },
  ]) {
    const res = await join(body);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'Enter a US phone number.');
  }
  assert.equal(
    (await join({ phone: '4255550100', pad: 'x'.repeat(2000) }, '10.8.8.8'))
      .status,
    413,
  );
  assert.equal(jobs().length, 0);
});
test('join reveals nothing and sends nothing for existing users', async () => {
  makeUser({ phone: '+14255550101' });
  const stopped = makeUser({ phone: '+14255550102' });
  db.prepare("UPDATE users SET opted_out=1, step='new' WHERE id=?").run(
    stopped,
  );
  assert.equal((await join({ phone: '+14255550101' })).status, 202);
  assert.equal((await join({ phone: '+14255550102' })).status, 202);
  assert.equal(jobs().length, 0);
  assert.equal(sent.length, 0);
});
test('join answers 202 even when delivery fails', async () => {
  setTransport(async () => {
    throw Error('offline');
  });
  assert.equal((await join({ phone: '4255550103' })).status, 202);
  assert.equal(
    db.prepare('SELECT status FROM message_jobs').get()!.status,
    'failed',
  );
});
test('join rate-limits per IP', async () => {
  for (let i = 0; i < 5; i++)
    assert.equal((await join({ phone: `42555501${10 + i}` })).status, 202);
  const res = await join({ phone: '4255550199' });
  assert.equal(res.status, 429);
  assert.equal((await res.json()).error, 'Too many tries. Text us instead.');
  assert.equal((await join({ phone: '4255550199' }, '10.9.9.9')).status, 202);
});
test('join preflight allows only configured origins', async () => {
  const preflight = (origin: string) =>
    fetch(base + '/join', {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'POST',
      },
    });
  const ok = await preflight('https://joinmixr.club');
  assert.equal(ok.status, 204);
  assert.equal(
    ok.headers.get('access-control-allow-origin'),
    'https://joinmixr.club',
  );
  assert.equal(ok.headers.get('access-control-allow-methods'), 'POST');
  assert.equal(ok.headers.get('access-control-allow-headers'), 'Content-Type');
  assert.equal(ok.headers.get('vary'), 'Origin');
  const bad = await preflight('https://evil.example');
  assert.equal(bad.headers.get('access-control-allow-origin'), null);
  const post = await fetch(base + '/join', {
    method: 'POST',
    headers: { Origin: 'https://www.joinmixr.club' },
    body: JSON.stringify({ phone: '4255550104' }),
  });
  assert.equal(
    post.headers.get('access-control-allow-origin'),
    'https://www.joinmixr.club',
  );
});
