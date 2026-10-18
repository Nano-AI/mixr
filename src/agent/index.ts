import { getOrCreateUser } from '../db/index.ts';
import { now } from '../clock.ts';
import { recordInbound, send } from '../transport/index.ts';
import { runDue } from '../jobs/index.ts';
import { llm, type AgentInputItem } from '../llm/index.ts';
import { trace } from '../trace.ts';
import { buildInput } from './context.ts';
import { INSTRUCTIONS } from './prompt.ts';
import { agentTools, runTool } from './tools.ts';

export const MAX_LLM_CALLS = 6; // tune: Responses calls per inbound text before we give up
const FALLBACK_REPLY = 'sorry, got a little tangled up there. mind saying that again?';

export type ToolCallLog = { name: string; args: unknown; result: unknown };

// Activity searches always surface hosting explicitly. If the model's reply forgot, add a plain line (a
// statement, not a second question) so the option is never missing.
const HOST_LINE = "or i can host an event for this and invite people who'd be into it, just say the word.";
export function withHostOffer(reply: string, calls: ToolCallLog[]): string {
  const searched = calls.some((c) => c.name === 'find_people' && (c.args as { request?: unknown })?.request && !(c.result as { error?: unknown })?.error);
  if (!reply || !searched || /\bhost/i.test(reply)) return reply;
  return `${reply} ${HOST_LINE}`;
}

// Per-phone promise chain: two texts from one phone run one after the other, different phones run concurrently.
const chains = new Map<string, Promise<void>>();

// One incoming text from a (simulated) phone. Creates the user if new, runs the tool-calling agent, sends the reply.
export function handleInbound(phone: string, text: string): Promise<void> {
  const prev = chains.get(phone) ?? Promise.resolve();
  const run = prev.then(() => turn(phone, text));
  const tail = run.catch(() => {});
  chains.set(phone, tail);
  void tail.then(() => {
    if (chains.get(phone) === tail) chains.delete(phone);
  });
  return run;
}

async function turn(phone: string, text: string): Promise<void> {
  const user = await getOrCreateUser(phone);
  await recordInbound(user.id, text);

  const input: AgentInputItem[] = await buildInput(user, await now());
  const tools = agentTools();
  const toolCalls: ToolCallLog[] = [];
  let reply = '';
  let error: string | undefined;

  try {
    for (let i = 0; i < MAX_LLM_CALLS; i++) {
      const res = await llm().agent({ instructions: INSTRUCTIONS, input, tools });
      if (!res.calls.length) {
        reply = res.text.trim();
        break;
      }
      if (i === MAX_LLM_CALLS - 1) {
        // Out of budget with work still requested: don't run calls whose results the model would never see.
        reply = res.text.trim() || FALLBACK_REPLY;
        error = 'max_iterations';
        break;
      }
      if (res.text.trim()) input.push({ role: 'assistant', content: res.text });
      for (const c of res.calls) {
        input.push({ type: 'function_call', call_id: c.call_id, name: c.name, arguments: c.arguments });
        const { args, result } = await runTool(user.id, c.name, c.arguments);
        toolCalls.push({ name: c.name, args, result });
        input.push({ type: 'function_call_output', call_id: c.call_id, output: JSON.stringify(result) });
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    await trace('agent', user.id, { userId: user.id, phone, text, toolCalls, reply: null, error });
    throw e;
  }

  reply = withHostOffer(reply, toolCalls);
  if (reply) await send(user.id, reply);
  await trace('agent', user.id, { userId: user.id, phone, text, toolCalls, reply, ...(error ? { error } : {}) });
  await runDue();
}
