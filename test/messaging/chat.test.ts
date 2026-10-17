import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { db, reset } from '../../src/db.ts';
import { createRouter } from '../../src/messaging/router.ts';
import { createConversationAgent } from '../../src/messaging/agent.ts';
import { getState, saveState } from '../../src/messaging/state.ts';
import { setTransport } from '../../src/messaging/transport.ts';

const phone = '+14253694262';
beforeEach(() => { reset(); setTransport(async () => {}); });
function student() {
  return Number(db.prepare("INSERT INTO users(phone,step,email_verified) VALUES (?,'braindump',1)").run(phone).lastInsertRowid);
}
function apiResponse(content: unknown[], stop_reason = 'end_turn') {
  return new Response(JSON.stringify({ id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-haiku-5-5',
    content, stop_reason, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 20 } }),
    { headers: { 'Content-Type': 'application/json' } });
}
test('natural chat saves notes through a user-scoped Claude tool and stays out of scheduling', async () => {
  const id = student();
  const other = Number(db.prepare("INSERT INTO users(phone) VALUES ('+15550000002')").run().lastInsertRowid);
  let requests = 0;
  const converse = createConversationAgent({ ANTHROPIC_API_KEY: 'test-key' }, async (_url, init) => {
    requests++;
    if (requests === 1) return apiResponse([{ type: 'tool_use', id: 'notes1', name: 'save_interest_notes', input: { notes: 'Enjoys casual frisbee and wants to try chess.' } }], 'tool_use');
    const body = JSON.parse(String(init?.body));
    assert.match(body.messages.at(-1).content[0].content, /saved/);
    return apiResponse([{ type: 'text', text: 'What got you interested in chess?' }]);
  });
  const route = createRouter({ converse });
  const inbound = { from: phone, text: 'I play casual frisbee and want to try chess', providerId: 'chat' };
  await route(inbound); await route(inbound);
  assert.equal(requests, 2);
  assert.equal(getState(id).interestNotes, 'Enjoys casual frisbee and wants to try chess.');
  assert.equal(getState(other).interestNotes, undefined);
  assert.equal(getState(id).chatHistory?.length, 2);
  assert.equal(db.prepare('SELECT step FROM users WHERE id=?').get(id)!.step, 'braindump');
  assert.equal(db.prepare('SELECT count(*) n FROM availability').get()!.n, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM message_jobs').get()!.n, 1);
  assert.match(String(db.prepare('SELECT text FROM message_jobs').get()!.text), /chess/);
});
test('a tool cannot select another user or change scheduling state', async () => {
  const id = student(); let requests = 0;
  const converse = createConversationAgent({ ANTHROPIC_API_KEY: 'test-key' }, async (_url, init) => {
    if (++requests === 1) return apiResponse([{ type: 'tool_use', id: 'invalid', name: 'save_interest_notes', input: { userId: 999, notes: 'injected' } }], 'tool_use');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.messages.at(-1).content[0].is_error, true);
    return apiResponse([{ type: 'text', text: 'Tell me more about what you enjoy.' }]);
  });
  await createRouter({ converse })({ from: phone, text: 'hello', providerId: 'invalid-tool' });
  assert.equal(requests, 2);
  assert.equal(getState(id).interestNotes, undefined);
});
test('key failure keeps the student in conversation with a clear retry message', async () => {
  const id = student();
  await createRouter({ converse: createConversationAgent({}) })({ from: phone, text: 'frisbee', providerId: 'missing-key' });
  assert.equal(db.prepare('SELECT step FROM users WHERE id=?').get(id)!.step, 'braindump');
  assert.match(String(db.prepare('SELECT text FROM message_jobs').get()!.text), /trouble.*chat|chat.*unavailable/i);
  assert.equal(getState(id).chatHistory, undefined);
});
test('consent, email codes, STOP and HELP never invoke Claude', async () => {
  let calls = 0;
  const route = createRouter({ converse: async () => { calls++; return 'unused'; } });
  for (const [i, text] of ['hello', 'YES', 'Ana', 'HELP', 'STOP', 'hi'].entries())
    await route({ from: phone, text, providerId: `control-${i}` });
  assert.equal(calls, 0);
});

test('PROFILE preserves newer corrections even when Claude did not save notes', async () => {
  const id = student();
  saveState(id, { interestNotes: 'Likes frisbee', draft: 'I like frisbee' });
  let extracted = '';
  const route = createRouter({
    converse: async (input) => {
      assert.match(input.profile ?? '', /Likes frisbee/);
      return 'Got it, chess is your focus now.';
    },
    buildProfile: async (_id, text) => {
      extracted = text;
      return { summary: text, interests: [], constraints: [], vibe: '' };
    },
  });
  await route({ from: phone, text: 'I stopped playing frisbee. I only want chess now.', providerId: 'correction' });
  await route({ from: phone, text: 'PROFILE', providerId: 'review' });
  assert.match(extracted, /only want chess now/);
  assert.match(getState(id).draft!, /only want chess now/);
});
test('natural YES replies with no RSVP target remain conversational', async () => {
  const id = student(); db.prepare("UPDATE users SET step='active' WHERE id=?").run(id);
  let calls = 0;
  const route = createRouter({ converse: async () => { calls++; return 'What kind of chess do you enjoy?'; } });
  await route({ from: phone, text: 'Yes I enjoy chess', providerId: 'natural-yes' });
  await route({ from: phone, text: 'YES', providerId: 'bare-yes' });
  assert.equal(calls, 2);
  assert.ok(db.prepare('SELECT text FROM message_jobs').all().every(j => /chess/.test(String(j.text))));
});
