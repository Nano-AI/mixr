import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withMessageIndicators } from '../../src/messaging/photon.ts';

test('read and typing indicators surround processing and stop after handler failure', async () => {
  const events: string[] = [];
  const message = {
    read: async () => {
      events.push('read');
    },
  };
  const space = {
    startTyping: async () => {
      events.push('start');
    },
    stopTyping: async () => {
      events.push('stop');
    },
  };
  await assert.rejects(
    withMessageIndicators(message, space, async () => {
      events.push('process');
      throw Error('handler failed');
    }),
    /handler failed/,
  );
  assert.deepEqual(events, ['read', 'start', 'process', 'stop']);
});
test('indicator failures do not prevent processing or replace its result', async () => {
  let processed = false;
  const fail = async () => {
    throw Error('indicator unavailable');
  };
  await withMessageIndicators(
    { read: fail },
    { startTyping: fail, stopTyping: fail },
    async () => {
      processed = true;
    },
  );
  assert.equal(processed, true);
});
