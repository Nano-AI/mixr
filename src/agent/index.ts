import { getOrCreateUser } from '../db/index.ts';
import { runIn, type RunContext } from '../context.ts';
import { now } from '../clock.ts';
import { recordInbound, send } from '../transport/index.ts';
import { runDue } from '../jobs/index.ts';
import { llm, LlmBudgetError, type AgentInputItem } from '../llm/index.ts';
import { trace } from '../trace.ts';
import { buildInput } from './context.ts';
import { INSTRUCTIONS } from './prompt.ts';
import { agentTools, runTool } from './tools.ts';

export const MAX_LLM_CALLS = 6; // tune: model calls per inbound text before we give up
const FALLBACK_REPLY = 'sorry, got a little tangled up there. mind saying that again?';
const BUSY_REPLY = "i'm swamped right now and can't think straight. try me again in a bit!";

export type ToolCallLog = { name: string; args: unknown; result: unknown };

// A reply that's about our machinery rather than to the student: a bracketed note, tool names, "tool call".
const TOOL_NAMES = /\b(save_profile|edit_profile|create_event|respond_to_invite|manage_event|discover_events|join_event|find_people|request_intro|respond_to_intro|block_person|unblock_person|add_requirement|remove_requirement|snooze)\b/;
export const looksInternal = (text: string): boolean =>
  /^\s*\[[^\]]*\]\s*$/.test(text) || TOOL_NAMES.test(text) || /\b(tool|function)s? (call|use)|called in parallel/i.test(text);
const NUDGE =
  "(system note, not from the student: your last reply described tool calls instead of making them, and the student can't see tools. If you need a tool, call it now; then reply to the student in plain words.)";

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

// One incoming text. Creates the user if new, runs the tool-calling agent, sends the reply.
//   via 'phone':     a real iMessage (the Photon adapter). Real pool; replies are delivered.
//   via 'dashboard': typed in the simulator (the default, so nothing is delivered by accident). A number first
//                    seen here joins the demo pool; for a real user it's "acting as" them: replies to them stay in
//                    the dashboard, while everything else behaves like real life.
// opts.recorded: the messaging pipeline already logged this text (it redacts codes and handles commands first).
export function handleInbound(phone: string, text: string, via: 'phone' | 'dashboard' = 'dashboard', opts: { recorded?: boolean } = {}): Promise<void> {
  const prev = chains.get(phone) ?? Promise.resolve();
  const run = prev.then(async () => {
    const user = await getOrCreateUser(phone, { demo: via === 'dashboard' });
    if (via === 'phone' && user.seeded) return; // demo numbers are fake; never act on a real message for one
    const ctx: RunContext = user.seeded
      ? { pool: 'demo', deliver: false }
      : via === 'phone'
        ? { pool: 'real', deliver: true }
        : { pool: 'real', deliver: true, quietUser: user.id };
    await runIn(ctx, () => turn(phone, text, via, !!opts.recorded));
  });
  const tail = run.catch(() => {});
  chains.set(phone, tail);
  void tail.then(() => {
    if (chains.get(phone) === tail) chains.delete(phone);
  });
  return run;
}

async function turn(phone: string, text: string, via: 'phone' | 'dashboard', recorded: boolean): Promise<void> {
  const user = await getOrCreateUser(phone);
  if (!recorded) await recordInbound(user.id, text, via);

  const input: AgentInputItem[] = await buildInput(user, await now());
  const tools = agentTools();
  const toolCalls: ToolCallLog[] = [];
  let reply = '';
  let error: string | undefined;
  let nudged = false;

  try {
    for (let i = 0; i < MAX_LLM_CALLS; i++) {
      const res = await llm().agent({ instructions: INSTRUCTIONS, input, tools });
      if (!res.calls.length) {
        // The model sometimes narrates tool use ("[find_people and discover_events called]") instead of making
        // the calls. That must never reach a phone: ask once more for real calls, then fall back.
        if (looksInternal(res.text) && !nudged && i < MAX_LLM_CALLS - 1) {
          nudged = true;
          if (res.raw !== undefined) input.push({ type: 'assistant_raw', content: res.raw });
          else input.push({ role: 'assistant', content: res.text });
          input.push({ role: 'user', content: NUDGE });
          error = 'narrated_tools';
          continue;
        }
        reply = looksInternal(res.text) ? FALLBACK_REPLY : res.text.trim();
        break;
      }
      if (i === MAX_LLM_CALLS - 1) {
        // Out of budget with work still requested: don't run calls whose results the model would never see.
        reply = res.text.trim() || FALLBACK_REPLY;
        error = 'max_iterations';
        break;
      }
      // Claude's turn goes back verbatim (thinking blocks must be passed back unmodified with tool results).
      if (res.raw !== undefined) input.push({ type: 'assistant_raw', content: res.raw });
      else if (res.text.trim()) input.push({ role: 'assistant', content: res.text });
      for (const c of res.calls) {
        if (res.raw === undefined) input.push({ type: 'function_call', call_id: c.call_id, name: c.name, arguments: c.arguments });
        const { args, result } = await runTool(user.id, c.name, c.arguments);
        toolCalls.push({ name: c.name, args, result });
        input.push({ type: 'function_call_output', call_id: c.call_id, output: JSON.stringify(result) });
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    // Out of daily Claude budget: say so instead of going silent.
    if (e instanceof LlmBudgetError) {
      await send(user.id, BUSY_REPLY);
      await trace('agent', user.id, { userId: user.id, phone, text, toolCalls, reply: BUSY_REPLY, error });
      return;
    }
    await trace('agent', user.id, { userId: user.id, phone, text, toolCalls, reply: null, error });
    throw e;
  }

  reply = withHostOffer(reply, toolCalls);
  if (reply) await send(user.id, reply);
  await trace('agent', user.id, { userId: user.id, phone, text, toolCalls, reply, ...(error ? { error } : {}) });
  await runDue();
}
