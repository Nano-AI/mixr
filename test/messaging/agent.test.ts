import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConversationAgent } from '../../src/messaging/agent.ts';
import { db } from '../../src/db.ts';

const response = (text: string) => new Response(JSON.stringify({
  id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-haiku-5-5',
  content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null,
  usage: { input_tokens: 120, output_tokens: 20 },
}), { status: 200, headers: { 'Content-Type': 'application/json' } });

test('Haiku request uses bounded history, a small token cap, and redacts contact details and codes', async () => {
  let body: any;
  let workspace: string | null = null;
  const agent = createConversationAgent({ LLM: 'anthropic', ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_WORKSPACE_ID: 'wrkspc_test' }, async (_url, init) => {
    body = JSON.parse(String(init?.body));
    workspace = new Headers(init?.headers).get('anthropic-workspace-id');
    return response('What got you into frisbee?');
  });
  const messages = Array.from({ length: 24 }, (_, i) => ({
    role: i % 2 ? 'assistant' as const : 'user' as const,
    content: i === 22 ? 'Reach me at person@uw.edu +14253694262, code 123456' : 'frisbee '.repeat(500),
  }));
  const reply = await agent({ phase: 'interests', messages, profile: 'person@uw.edu likes frisbee' });
  assert.equal(reply, 'What got you into frisbee?');
  assert.equal(body.model, 'claude-haiku-5-5');
  assert.equal(workspace, 'wrkspc_test');
  assert.equal(body.max_tokens, 256);
  assert.ok(body.messages.length <= 8);
  assert.ok(body.messages.every((m: any) => m.content.length <= 1200));
  assert.doesNotMatch(JSON.stringify(body), /person@uw.edu|14253694262|123456|test-key/);
  assert.match(body.system, /never.*(book|confirm)/i);
});
test('API errors are not retried or leaked into student replies', async () => {
  let attempts = 0;
  const agent = createConversationAgent({ ANTHROPIC_API_KEY: 'test-key' }, async () => {
    attempts++;
    return new Response(JSON.stringify({ error: { type: 'rate_limit_error', message: 'private diagnostic' } }), {
      status: 429, headers: { 'Content-Type': 'application/json' },
    });
  });
  await assert.rejects(agent({ phase: 'active', messages: [{ role: 'user', content: 'hello' }] }), /Conversation unavailable/);
  assert.equal(attempts, 1);
});
test('empty or truncated model output is rejected', async () => {
  const agent = createConversationAgent({ ANTHROPIC_API_KEY: 'test-key' }, async () => response('  '));
  await assert.rejects(agent({ phase: 'active', messages: [{ role: 'user', content: 'hello' }] }), /Conversation unavailable/);
});
test('missing key fails without a request; fake mode stays offline even with a key', async () => {
  let requests = 0;
  const fetcher: typeof fetch = async () => { requests++; return response('network reply'); };
  const missing = createConversationAgent({}, fetcher);
  await assert.rejects(missing({ phase: 'interests', messages: [{ role: 'user', content: 'frisbee' }] }), /not configured/i);
  const fake = createConversationAgent({ LLM: 'fake', ANTHROPIC_API_KEY: 'unused' }, fetcher);
  assert.ok(await fake({ phase: 'interests', messages: [{ role: 'user', content: 'frisbee' }] }));
  assert.equal(requests, 0);
});

test('small-budget tool conversations disable thinking on both requests to leave room for a reply', async () => {
  let requests = 0;
  let notes = '';
  const agent = createConversationAgent({ ANTHROPIC_API_KEY: 'test-key' }, async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    requests++;
    assert.equal(body.max_tokens, 256);
    // Reproduce the upstream failure: adaptive thinking exhausts the short budget.
    if (body.thinking?.type !== 'disabled') {
      return Response.json({
        id: 'msg_exhausted', type: 'message', role: 'assistant', model: body.model,
        content: [], stop_reason: 'max_tokens', stop_sequence: null,
        usage: { input_tokens: 120, output_tokens: 256 },
      });
    }
    if (requests === 1) return Response.json({
      id: 'msg_tool', type: 'message', role: 'assistant', model: body.model,
      content: [{ type: 'tool_use', id: 'tool_notes', name: 'save_interest_notes', input: { notes: 'Likes chess' } }],
      stop_reason: 'tool_use', stop_sequence: null,
      usage: { input_tokens: 120, output_tokens: 30 },
    });
    assert.equal(body.tool_choice.type, 'none');
    assert.equal(body.messages.at(-1).content[0].tool_use_id, 'tool_notes');
    return response('Saved that you like chess. Do you play casually?');
  });
  const reply = await agent({
    phase: 'active', messages: [{ role: 'user', content: 'Remember that I like chess.' }],
    tools: { readProfile: () => ({}), saveNotes: value => { notes = value; return { saved: true }; } },
  });
  assert.equal(notes, 'Likes chess');
  assert.equal(reply, 'Saved that you like chess. Do you play casually?');
  assert.equal(requests, 2);
});

test('daily request cap persists across agent instances and prevents additional API requests', async () => {
  db.prepare('DELETE FROM claude_request_budget').run();
  let requests = 0;
  const env = { ANTHROPIC_API_KEY: 'test-key', CLAUDE_DAILY_REQUEST_LIMIT: '1' };
  const fetcher: typeof fetch = async () => { requests++; return response('Hello!'); };
  const input = { phase: 'active' as const, messages: [{ role: 'user' as const, content: 'hello' }] };
  assert.equal(await createConversationAgent(env, fetcher)(input), 'Hello!');
  await assert.rejects(createConversationAgent(env, fetcher)(input), /Conversation unavailable/);
  assert.equal(requests, 1);
});
