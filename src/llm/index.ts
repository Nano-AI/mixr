import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.ts';
import { q } from '../db/index.ts';
import { trace } from '../trace.ts';

// The only place that talks to the chat model (Claude). Everything else goes through `llm()`.
// Never call it from tests, seed scripts, or dev tooling: those run on FakeLlm.

export type JsonRequest = {
  name: string; // stable id for the call site, e.g. 'canonicalize_profile'. Fakes key off it.
  system: string;
  input: string;
  schema: Record<string, unknown>; // JSON schema: every property required, additionalProperties false
  // Pure reformatting under the schema: skip thinking (Haiku 5.5 thinks by default; disabled is accepted at
  // effort high or lower, and these run at low). Leave unset for judgment calls like rerank.
  noThinking?: boolean;
};

export type AgentInputItem =
  | { role: 'user' | 'assistant' | 'developer'; content: string }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string }
  // The provider's own assistant turn (thinking + text + tool calls), passed back verbatim on the next call.
  | { type: 'assistant_raw'; content: unknown };

export type AgentTool = { name: string; description: string; parameters: Record<string, unknown> };
export type AgentRequest = { instructions: string; input: AgentInputItem[]; tools: AgentTool[] };
export type AgentCall = { call_id: string; name: string; arguments: string };
export type AgentResponse = { text: string; calls: AgentCall[]; raw?: unknown };

export interface Llm {
  // True when this LLM can serve the named pipeline call (fakes only serve calls with a registered handler).
  handles(name: string): boolean;
  json<T>(req: JsonRequest): Promise<T>;
  agent(req: AgentRequest): Promise<AgentResponse>;
}

// Thrown when the daily request cap is used up. Pipeline steps fall back; the agent sends a short apology.
export class LlmBudgetError extends Error {}

const AGENT_MAX_TOKENS = 2048; // tune: thinking + tool arguments + one SMS reply
const JSON_MAX_TOKENS = 4096; // tune: rerank over 40 candidates is the largest structured output
const EFFORT = 'low' as const; // tune: SMS turns and matching judgments are short; low keeps latency down

// Count the attempt before making it (failures count too), so restarts and crashes can't exceed the cap.
async function spendOne(): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  const [{ requests }] = await q<{ requests: number }>(
    `INSERT INTO llm_budget (day, requests) VALUES ($1, 1)
     ON CONFLICT (day) DO UPDATE SET requests = llm_budget.requests + 1 RETURNING requests`,
    [day],
  );
  if (requests > config.claudeDailyLimit) throw new LlmBudgetError(`daily Claude request cap (${config.claudeDailyLimit}) reached`);
}

// Our schemas are written portably (nullable as `type: ['string', 'null']`). Claude's structured outputs want
// anyOf for that, and reject numeric/string constraints, so normalize recursively.
export function toClaudeSchema(s: unknown): unknown {
  if (Array.isArray(s)) return s.map(toClaudeSchema);
  if (!s || typeof s !== 'object') return s;
  const { minimum, maximum, minLength, maxLength, multipleOf, ...rest } = s as Record<string, unknown>;
  void minimum, maximum, minLength, maxLength, multipleOf;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest)) out[k] = k === 'properties' && v && typeof v === 'object'
    ? Object.fromEntries(Object.entries(v).map(([p, ps]) => [p, toClaudeSchema(ps)]))
    : toClaudeSchema(v);
  if (Array.isArray(out.type) && out.type.includes('null')) {
    const types = (out.type as string[]).filter((t) => t !== 'null');
    const { type: _t, description, ...shape } = out;
    void _t;
    const nonNull = types.length === 1 ? { type: types[0], ...shape } : { type: types, ...shape };
    return { anyOf: [nonNull, { type: 'null' }], ...(description ? { description } : {}) };
  }
  return out;
}

// Our provider-neutral turn items -> Claude messages. Consecutive tool calls / results are grouped into one
// assistant / user message; the per-turn context (developer) becomes a mid-conversation system message.
export function toClaudeMessages(input: AgentInputItem[]): Anthropic.MessageParam[] {
  const out: any[] = [];
  const lastIs = (role: string, kind: string) => {
    const m = out[out.length - 1];
    return m && m.role === role && Array.isArray(m.content) && m.content.every((b: any) => b.type === kind);
  };
  for (const item of input) {
    if ('role' in item) {
      if (item.role === 'developer') out.push({ role: 'system', content: item.content });
      else if (item.content.trim()) out.push({ role: item.role, content: item.content });
    } else if (item.type === 'assistant_raw') {
      out.push({ role: 'assistant', content: item.content });
    } else if (item.type === 'function_call') {
      const block = { type: 'tool_use', id: item.call_id, name: item.name, input: safeJson(item.arguments) };
      if (lastIs('assistant', 'tool_use')) out[out.length - 1].content.push(block);
      else out.push({ role: 'assistant', content: [block] });
    } else if (item.type === 'function_call_output') {
      const block = { type: 'tool_result', tool_use_id: item.call_id, content: item.output };
      if (lastIs('user', 'tool_result')) out[out.length - 1].content.push(block);
      else out.push({ role: 'user', content: [block] });
    }
  }
  // The API wants a user turn first; conversations mixr started (an invite) begin with an assistant text.
  const first = out.findIndex((m) => m.role !== 'system');
  if (first >= 0 && out[first].role === 'assistant') out.splice(first, 0, { role: 'user', content: '(mixr texted first)' });
  return out as Anthropic.MessageParam[];
}

const safeJson = (s: string): unknown => {
  try {
    return JSON.parse(s || '{}');
  } catch {
    return {};
  }
};

export class ClaudeLlm implements Llm {
  private client = new Anthropic({
    apiKey: config.anthropicKey,
    maxRetries: 1,
    timeout: 30_000,
    ...(config.anthropicWorkspace ? { defaultHeaders: { 'anthropic-workspace-id': config.anthropicWorkspace } } : {}),
  });

  handles(): boolean {
    return true;
  }

  async json<T>(req: JsonRequest): Promise<T> {
    await spendOne();
    const started = Date.now();
    const r = await this.client.messages.create({
      model: config.anthropicModel,
      max_tokens: JSON_MAX_TOKENS,
      system: req.system,
      messages: [{ role: 'user', content: req.input }],
      ...(req.noThinking ? { thinking: { type: 'disabled' } } : {}),
      output_config: { effort: EFFORT, format: { type: 'json_schema', schema: toClaudeSchema(req.schema) as Record<string, unknown> } },
    } as Anthropic.MessageCreateParamsNonStreaming);
    await trace('llm', null, { purpose: req.name, usage: r.usage, ms: Date.now() - started, stop: r.stop_reason });
    if (r.stop_reason === 'refusal' || r.stop_reason === 'max_tokens') throw new Error(`${req.name}: stopped (${r.stop_reason})`);
    const text = r.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text ?? '';
    return JSON.parse(text) as T;
  }

  async agent(req: AgentRequest): Promise<AgentResponse> {
    await spendOne();
    const started = Date.now();
    const r = await this.client.messages.create({
      model: config.anthropicModel,
      max_tokens: AGENT_MAX_TOKENS,
      // Two breakpoints. The explicit one on the system block caches tools + instructions (identical for every
      // user and turn). The automatic one lands on the last block, the per-turn context, so it only helps the
      // next call within this same turn (tool loop); without the explicit one the shared prefix was never reused.
      cache_control: { type: 'ephemeral' },
      system: [{ type: 'text', text: req.instructions, cache_control: { type: 'ephemeral' } }],
      messages: toClaudeMessages(req.input),
      tools: req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: toClaudeSchema(t.parameters) as Anthropic.Tool.InputSchema,
        strict: true,
      })),
      output_config: { effort: EFFORT },
    } as Anthropic.MessageCreateParamsNonStreaming);
    await trace('llm', null, { purpose: 'agent', usage: r.usage, ms: Date.now() - started, stop: r.stop_reason });
    const text = r.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    const calls = r.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
      .map((b) => ({ call_id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) }));
    if (r.stop_reason === 'refusal') return { text: text || "sorry, i can't help with that one.", calls: [] };
    return { text, calls, raw: r.content };
  }
}

// Deterministic stand-in for tests and credit-free dev. Register handlers per call name.
export class FakeLlm implements Llm {
  jsonHandlers = new Map<string, (req: JsonRequest) => unknown>();
  agentHandler: (req: AgentRequest) => AgentResponse | Promise<AgentResponse> = (req) => {
    const last = [...req.input].reverse().find((i) => 'role' in i && i.role === 'user') as { content: string } | undefined;
    return { text: `(fake agent) got: ${last?.content ?? ''}`, calls: [] };
  };

  onJson(name: string, fn: (req: JsonRequest) => unknown): this {
    this.jsonHandlers.set(name, fn);
    return this;
  }

  handles(name: string): boolean {
    return this.jsonHandlers.has(name);
  }

  async json<T>(req: JsonRequest): Promise<T> {
    const fn = this.jsonHandlers.get(req.name);
    if (!fn) throw new Error(`FakeLlm: no handler for '${req.name}'`);
    return fn(req) as T;
  }

  async agent(req: AgentRequest): Promise<AgentResponse> {
    return this.agentHandler(req);
  }
}

let current: Llm = config.fake ? new FakeLlm() : new ClaudeLlm();

export const llm = (): Llm => current;
export const setLlm = (l: Llm): void => void (current = l);

// Pipeline steps (canonicalize, HyDE, rerank, evolve) call this first and use their non-LLM fallback when false.
export const pipelineLlm = (name: string): boolean => config.pipelineLlm && current.handles(name);
