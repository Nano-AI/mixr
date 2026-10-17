import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from '../../src/messaging/http.ts';
import { parseSpectrumMessage } from '../../src/messaging/photon.ts';

test('health responds and message inspection requires a bearer token', async () => {
  const server = createServer(() => true, 'test-admin-token');
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(base + '/health')).status, 200);
    assert.equal((await fetch(base + '/admin/messages')).status, 401);
    assert.equal(
      (await fetch(base + '/admin/messages?token=test-admin-token')).status,
      401,
    );
    assert.equal(
      (
        await fetch(base + '/admin/messages', {
          headers: { Authorization: 'Bearer test-admin-token' },
        })
      ).status,
      200,
    );
  } finally {
    server.close();
    await once(server, 'close');
  }
});
test('adapter rejects malformed, outbound, group and non-phone identities', () => {
  const event = {
    platform: 'imessage',
    direction: 'inbound',
    id: 'event-1',
    sender: { id: '+14253694262' },
    content: { type: 'text', text: 'hi' },
  };
  assert.deepEqual(parseSpectrumMessage({ type: 'dm' }, event), {
    from: '+14253694262',
    text: 'hi',
    providerId: 'imessage:event-1',
  });
  for (const e of [
    null,
    {},
    { ...event, direction: 'outbound' },
    { ...event, sender: { id: 'email@uw.edu' } },
    { ...event, content: { type: 'text', text: 42 } },
  ])
    assert.equal(parseSpectrumMessage({ type: 'dm' }, e), null);
  assert.equal(parseSpectrumMessage({ type: 'group' }, event), null);
});
