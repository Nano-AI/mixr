import OpenAI from 'openai';
import { config } from '../config.ts';
import { trace } from '../trace.ts';

// The only place that talks to the chat model. Everything else goes through `llm()`.
// gpt-6-luna credits are scarce: never call it from tests, seed scripts, or dev tooling.

export type JsonRequest = {
  name: string; // stable id for the call site, e.g. 'canonicalize_profile'. Fakes key off it.
  system: string;
  input: string;
  schema: Record<string, unknown>; // JSON schema, strict mode (every property required, additionalProperties false)
};

export type AgentInputItem =
  | { role: 'user' | 'assistant' | 'developer'; content: string }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string };

export type AgentTool = { name: string; description: string; parameters: Record<string, unknown> };
export type AgentRequest = { instructions: string; input: AgentInputItem[]; tools: AgentTool[] };
export type AgentCall = { call_id: string; name: string; arguments: string };
export type AgentResponse = { text: string; calls: AgentCall[] };

export interface Llm {
  // True when this LLM can serve the named pipeline call (fakes only serve calls with a registered handler).
  handles(name: string): boolean;
  json<T>(req: JsonRequest): Promise<T>;
  agent(req: AgentRequest): Promise<AgentResponse>;
}

class OpenAiLlm implements Llm {
  private client = new OpenAI({ apiKey: config.openaiKey });

  handles(): boolean {
    return true;
  }

  async json<T>(req: JsonRequest): Promise<T> {
    const r = await this.client.responses.create({
      model: config.llmModel,
      reasoning: { effort: 'low' },
      instructions: req.system,
      input: req.input,
      text: { format: { type: 'json_schema', name: req.name, strict: true, schema: req.schema } },
    });
    await trace('llm', null, { purpose: req.name, usage: r.usage });
    return JSON.parse(r.output_text) as T;
  }

  async agent(req: AgentRequest): Promise<AgentResponse> {
    const r = await this.client.responses.create({
      model: config.llmModel,
      reasoning: { effort: 'low' },
      instructions: req.instructions,
      input: req.input as any,
      tools: req.tools.map((t) => ({ type: 'function' as const, name: t.name, description: t.description, parameters: t.parameters, strict: true })),
    });
    await trace('llm', null, { purpose: 'agent', usage: r.usage });
    const calls = r.output.filter((o: any) => o.type === 'function_call').map((o: any) => ({ call_id: o.call_id, name: o.name, arguments: o.arguments }));
    return { text: r.output_text ?? '', calls };
  }
}

// Deterministic stand-in for tests and credit-free dev. Register handlers per call name.
export class FakeLlm implements Llm {
  jsonHandlers = new Map<string, (req: JsonRequest) => unknown>();
  agentHandler: (req: AgentRequest) => AgentResponse = (req) => {
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

let current: Llm = config.fake ? new FakeLlm() : new OpenAiLlm();

export const llm = (): Llm => current;
export const setLlm = (l: Llm): void => void (current = l);

// Pipeline steps (canonicalize, HyDE, rerank, evolve) call this first and use their non-LLM fallback when false.
export const pipelineLlm = (name: string): boolean => config.pipelineLlm && current.handles(name);
