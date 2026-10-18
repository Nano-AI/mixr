import { test, expect } from 'vitest';
import { toClaudeMessages, toClaudeSchema } from '../src/llm/index.ts';

test('schemas: nullable type arrays become anyOf, unsupported constraints are dropped, nesting is kept', () => {
  const s = toClaudeSchema({
    type: 'object',
    properties: {
      name: { type: ['string', 'null'], description: 'first name' },
      n: { type: 'integer', minimum: 1, maximum: 10 },
      list: { type: 'array', items: { type: 'object', properties: { id: { type: ['integer', 'null'] } }, required: ['id'], additionalProperties: false } },
    },
    required: ['name', 'n', 'list'],
    additionalProperties: false,
  }) as any;
  expect(s.properties.name).toEqual({ anyOf: [{ type: 'string' }, { type: 'null' }], description: 'first name' });
  expect(s.properties.n).toEqual({ type: 'integer' });
  expect(s.properties.list.items.properties.id).toEqual({ anyOf: [{ type: 'integer' }, { type: 'null' }] });
  expect(s.additionalProperties).toBe(false);
});

test('messages: history, grouped tool calls/results, context as a trailing system message, user first', () => {
  const m = toClaudeMessages([
    { role: 'assistant', content: 'hey! mixr here, invite for you' },
    { role: 'user', content: 'yeah im down' },
    { role: 'developer', content: '[context]' },
    { type: 'function_call', call_id: 'a', name: 'respond_to_invite', arguments: '{"event_id":1,"response":"yes"}' },
    { type: 'function_call', call_id: 'b', name: 'discover_events', arguments: '{"query":null}' },
    { type: 'function_call_output', call_id: 'a', output: '{"ok":true}' },
    { type: 'function_call_output', call_id: 'b', output: '{"events":[]}' },
  ]) as any[];
  expect(m[0]).toEqual({ role: 'user', content: '(mixr texted first)' });
  expect(m[1].role).toBe('assistant');
  expect(m[3]).toEqual({ role: 'system', content: '[context]' });
  expect(m[4].role).toBe('assistant');
  expect(m[4].content.map((b: any) => b.id)).toEqual(['a', 'b']);
  expect(m[4].content[0].input).toEqual({ event_id: 1, response: 'yes' });
  expect(m[5].role).toBe('user');
  expect(m[5].content.map((b: any) => b.tool_use_id)).toEqual(['a', 'b']);
});

test('messages: a raw provider turn is passed back verbatim', () => {
  const raw = [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'tool_use', id: 't1', name: 'x', input: {} }];
  const m = toClaudeMessages([
    { role: 'user', content: 'hi' },
    { type: 'assistant_raw', content: raw },
    { type: 'function_call_output', call_id: 't1', output: '{}' },
  ]) as any[];
  expect(m[1]).toEqual({ role: 'assistant', content: raw });
  expect(m[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 't1' });
});
