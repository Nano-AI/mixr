// One revision's eval, in-process. Spawned by scripts/eval/index.ts with cwd = that revision's checkout (a temporary
// git worktree) and an env that forces a throwaway DB, TRANSPORT=sim and no email. It imports the revision's own
// modules by path, so the same script measures any revision.
//   node --import tsx scripts/eval/run.ts --root <checkout> --out <dir> --label <name>
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mean, mrr, p90, precision, recallAt, replyStats, type ReplyStats } from './metrics.ts';

const arg = (k: string): string | undefined => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const root = arg('root') ?? process.cwd();
const outDir = arg('out') ?? join(import.meta.dirname, 'out', 'local');
const label = arg('label') ?? 'local';

const fake = process.env.MIXR_FAKE === '1'; // everything offline: fake embeddings + fake LLM
const fakeEmbeddings = fake || process.env.EVAL_FAKE_EMBED === '1'; // no OpenAI key: real Claude, fake vectors
const claude = !fake && !!process.env.ANTHROPIC_API_KEY && process.env.PIPELINE_LLM !== 'off';
if (process.env.TRANSPORT !== 'sim' || !process.env.DB_DIR) throw new Error('run.ts must be started by scripts/eval/index.ts (TRANSPORT=sim, throwaway DB_DIR)');

// USD per 1M tokens. Haiku 5.5 as given for this project; cache writes 1.25x input, cache reads 0.1x input.
export const PRICE = { input: 0.1, cacheWrite: 0.125, cacheRead: 0.01, output: 0.5, embed: 0.13 };

// ---- every model call, timed, with the usage the API returned. Anything else on the network is refused.
type Call = { stage: string; kind: 'claude' | 'embed'; purpose: string; ms: number; status: number; input: number; cacheWrite: number; cacheRead: number; output: number };
const calls: Call[] = [];
let stage = 'setup';
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(typeof input === 'string' || input instanceof URL ? input : input.url);
  const host = new URL(url).hostname;
  const kind = host === 'api.anthropic.com' ? 'claude' : host === 'api.openai.com' ? 'embed' : null;
  if (!kind) throw new Error(`eval: blocked network call to ${host}`);
  let purpose: string = kind;
  try {
    const body = JSON.parse(String(init?.body));
    if (kind === 'claude') purpose = body.tools?.length ? 'agent' : 'pipeline';
  } catch {}
  const t0 = performance.now();
  const res: Response = await realFetch(input, init);
  let u: any = {};
  try {
    u = (await res.clone().json()).usage ?? {};
  } catch {}
  calls.push({
    stage,
    kind,
    purpose,
    ms: performance.now() - t0,
    status: res.status,
    input: u.input_tokens ?? u.prompt_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    output: u.output_tokens ?? 0,
  });
  return res;
}) as typeof fetch;

const mod = (p: string): Promise<any> => import(pathToFileURL(join(root, p)).href);
const { q, one } = await mod('src/db/index.ts');
const { seed } = await mod('src/seed.ts');
const matching = await mod('src/matching/index.ts');
const embedding = await mod('src/llm/embed.ts');
const { embedOne } = embedding;
if (fakeEmbeddings && !fake) embedding.setEmbedder(embedding.fakeEmbed);

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const log = (s: string) => console.log(`[${label}] ${s}`);
log(`embeddings: ${fakeEmbeddings ? 'fake (deterministic bag-of-words hash)' : 'openai'}; claude: ${claude ? 'on' : 'off'}`);

stage = 'seed';
await seed();
const phoneOf = new Map<number, string>((await q('SELECT id, phone FROM users')).map((r: any) => [r.id, r.phone]));
const known = new Set(phoneOf.values());

// ---- 1. retrieval
type Query = { type: 'exact' | 'semantic'; text: string; expected: string[] };
const queries: Query[] = JSON.parse(readFileSync(join(import.meta.dirname, 'queries.json'), 'utf8'));
const unknownLabels = [...new Set(queries.flatMap((x) => x.expected).filter((p) => !known.has(p)))];
if (unknownLabels.length) log(`warning: ${unknownLabels.length} labelled phones are not in this revision's fixtures`);
// Hybrid recall (BM25 + vectors) takes the query text as opts.text. Passed either way; this only reports whether
// the revision's recall reads it.
const hybrid = /\.text\b|\btext\s*[,}=]/.test(String(matching.recall));

stage = 'retrieval';
const perQuery: any[] = [];
for (const x of queries) {
  const vec = await embedOne(`Looking for: ${x.text}`); // what findPeople embeds for a request
  const hits = await matching.recall(vec, { limit: 40, text: x.text, label: 'eval' });
  const ranked: string[] = hits.map((h: any) => phoneOf.get(h.userId)!);
  const row: any = { type: x.type, text: x.text, expected: x.expected.length, recall10: recallAt(ranked, x.expected, 10), recall40: recallAt(ranked, x.expected, 40), mrr: mrr(ranked, x.expected) };
  if (claude) {
    const picks = await matching.rerank({ purpose: 'people', target: `Looking for: ${x.text}`, candidates: hits, k: 5 });
    const picked: string[] = picks.map((p: any) => phoneOf.get(p.userId)!);
    Object.assign(row, { rrP5: precision(picked, x.expected), rrRecall5: recallAt(picked, x.expected, 5), rrMrr: mrr(picked, x.expected), picks: picked.length });
  }
  perQuery.push(row);
}
const agg = (rows: any[]) => {
  const m = (k: string) => r3(mean(rows.map((r) => r[k])));
  return { n: rows.length, recall10: m('recall10'), recall40: m('recall40'), mrr: m('mrr'), ...(claude ? { rrP5: m('rrP5'), rrRecall5: m('rrRecall5'), rrMrr: m('rrMrr') } : {}) };
};
const retrieval = {
  hybrid,
  rerank: claude,
  all: agg(perQuery),
  exact: agg(perQuery.filter((r) => r.type === 'exact')),
  semantic: agg(perQuery.filter((r) => r.type === 'semantic')),
  perQuery,
};
log(`retrieval: recall@10 ${retrieval.all.recall10}, recall@40 ${retrieval.all.recall40}, MRR ${retrieval.all.mrr}${claude ? `, rerank P@5 ${retrieval.all.rrP5}` : ' (rerank skipped: no Claude)'}`);

// ---- 2. conversations (real agent with Claude; the fake agent offline, as a plumbing smoke test only)
type Turn = { conv: string; text: string; bubbles: string[]; ms: number; calls: number; onboarding: boolean; stats?: ReplyStats; error?: string; note?: string };
const turns: Turn[] = [];
let conversations: any = { skipped: 'no ANTHROPIC_API_KEY (agent needs Claude)' };
if (claude || fake) {
  stage = 'conversation';
  const { processText } = await mod('src/messaging/pipeline.ts');
  const { send } = await mod('src/transport/index.ts');
  const onboarding = await mod('src/messaging/onboarding.ts').catch(() => ({}));
  onboarding.setCodeSender?.(async () => {
    throw new Error('eval: email is disabled');
  });
  const convs: { id: string; onboarding?: boolean; turns: string[] }[] = JSON.parse(readFileSync(join(import.meta.dirname, 'conversations.json'), 'utf8'));
  for (const [ci, conv] of convs.entries()) {
    const phone = `+1206555${9000 + ci}`;
    // A real user starting at consent (as if they joined on the site) goes through deterministic onboarding first.
    if (conv.onboarding) await q(`INSERT INTO users (phone, seeded, joined_via, step) VALUES ($1, false, 'web', 'consent')`, [phone]);
    let inOnboarding = !!conv.onboarding;
    const said: string[] = [];
    const earlier: string[] = [];
    for (const text of conv.turns) {
      if (text === '@verified') {
        // Skip the emailed code: mark verified the way tests do. Also move them to the demo pool, because matching
        // only searches the user's own pool and the 50 seeded students are demo users.
        await q(`UPDATE users SET step = NULL, email = $2, email_verified = true, seeded = true WHERE phone = $1`, [phone, `eval${ci}@uw.edu`]);
        const u = await one('SELECT id, name FROM users WHERE phone = $1', [phone]);
        const reply = onboarding.braindumpPrompt?.(u.name); // what a correct code gets back
        if (reply) await send(u.id, reply);
        turns.push({ conv: conv.id, text: '(code verified by the harness)', bubbles: reply ? [reply] : [], ms: 0, calls: 0, onboarding: true, note: 'verified in DB' });
        inOnboarding = false;
        continue;
      }
      const before = Number((await one('SELECT coalesce(max(id), 0) AS m FROM messages')).m);
      const c0 = calls.length;
      const t0 = performance.now();
      let error: string | undefined;
      try {
        await processText(phone, text, 'dashboard');
      } catch (e) {
        error = e instanceof Error ? e.message.slice(0, 200) : String(e);
      }
      const ms = performance.now() - t0;
      const u = await one('SELECT id FROM users WHERE phone = $1', [phone]);
      const bubbles: string[] = (await q(`SELECT text FROM messages WHERE user_id = $1 AND direction = 'out' AND id > $2 ORDER BY id`, [u.id, before])).map((r: any) => r.text);
      const turn: Turn = { conv: conv.id, text, bubbles, ms, calls: calls.slice(c0).filter((c) => c.kind === 'claude').length, onboarding: inOnboarding, ...(error ? { error } : {}) };
      if (!inOnboarding) turn.stats = replyStats(bubbles, said, earlier);
      turns.push(turn);
      said.push(text);
      earlier.push(...bubbles);
    }
    // Keep this user out of later conversations' matches.
    await q(`UPDATE users SET opted_out = true WHERE phone = $1`, [phone]);
  }
  const agent = turns.filter((t) => t.stats);
  const s = (f: (t: Turn) => number) => ({ mean: r3(mean(agent.map(f))), p90: r3(p90(agent.map(f))) });
  conversations = {
    fake,
    turns: agent.length,
    chars: s((t) => t.stats!.chars),
    bubbles: s((t) => t.stats!.bubbles),
    questions: s((t) => t.stats!.questions),
    capitalRate: r3(mean(agent.map((t) => +t.stats!.capital))),
    restateRate: r3(mean(agent.map((t) => +t.stats!.restates))),
    narration: s((t) => t.stats!.narration),
    narrationRate: r3(mean(agent.map((t) => +(t.stats!.narration > 0)))),
    dupes: agent.reduce((a, t) => a + t.stats!.dupes, 0),
    multiBubbleTurns: agent.filter((t) => t.stats!.bubbles > 1).length,
    silentTurns: agent.filter((t) => !t.stats!.bubbles).length,
    reactions: s((t) => t.stats!.reactions),
    reactOnlyTurns: agent.filter((t) => t.stats!.reactOnly).length,
    errors: turns.filter((t) => t.error).length,
    turnMs: s((t) => t.ms),
    callsPerTurn: s((t) => t.calls),
  };
  log(`conversations: ${agent.length} agent turns${fake ? ' (FAKE agent: plumbing smoke test, metrics not meaningful)' : ''}, ${conversations.errors} errors`);
}

// ---- 3. latency and tokens
const usage = (cs: Call[]) => ({
  calls: cs.length,
  failed: cs.filter((c) => c.status !== 200).length,
  msTotal: Math.round(cs.reduce((a, c) => a + c.ms, 0)),
  msMean: Math.round(mean(cs.map((c) => c.ms))),
  msP90: Math.round(p90(cs.map((c) => c.ms))),
  input: cs.reduce((a, c) => a + c.input, 0),
  cacheWrite: cs.reduce((a, c) => a + c.cacheWrite, 0),
  cacheRead: cs.reduce((a, c) => a + c.cacheRead, 0),
  output: cs.reduce((a, c) => a + c.output, 0),
});
const cost = (u: ReturnType<typeof usage>, perM = PRICE) =>
  (u.input * perM.input + u.cacheWrite * perM.cacheWrite + u.cacheRead * perM.cacheRead + u.output * perM.output) / 1e6;
const claudeCalls = calls.filter((c) => c.kind === 'claude');
const embedCalls = calls.filter((c) => c.kind === 'embed');
const convTurns = turns.filter((t) => t.stats).length || 1;
const conv = usage(claudeCalls.filter((c) => c.stage === 'conversation'));
const llm = {
  claude: usage(claudeCalls),
  retrieval: usage(claudeCalls.filter((c) => c.stage === 'retrieval')),
  conversation: conv,
  agentCalls: usage(claudeCalls.filter((c) => c.purpose === 'agent')),
  pipelineCalls: usage(claudeCalls.filter((c) => c.purpose === 'pipeline')),
  perTurn: { input: Math.round(conv.input / convTurns), cacheWrite: Math.round(conv.cacheWrite / convTurns), cacheRead: Math.round(conv.cacheRead / convTurns), output: Math.round(conv.output / convTurns), ms: Math.round(conv.msTotal / convTurns) },
  embed: { calls: embedCalls.length, tokens: embedCalls.reduce((a, c) => a + c.input, 0), msTotal: Math.round(embedCalls.reduce((a, c) => a + c.ms, 0)) },
  costUsd: 0,
};
llm.costUsd = Math.round((cost(llm.claude) + (llm.embed.tokens * PRICE.embed) / 1e6) * 10000) / 10000;
if (calls.length) log(`model calls: ${llm.claude.calls} claude, ${llm.embed.calls} embed; cost ~$${llm.costUsd}`);

// ---- write
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'results.json'), JSON.stringify({ label, mode: { fake, fakeEmbeddings, claude }, retrieval, conversations, llm, turns }, null, 2));
const md = [`# Transcripts: ${label}`, '', fake ? '_FAKE agent (offline smoke test). Replies are placeholders._\n' : ''];
let cur = '';
for (const t of turns) {
  if (t.conv !== cur) md.push(`\n## ${(cur = t.conv)}\n`);
  md.push(`**user:** ${t.text}`, '');
  for (const b of t.bubbles) md.push(`> **mixr:** ${b.replace(/\n/g, '\n> ')}`, '>');
  if (!t.bubbles.length) md.push('> _(no reply)_');
  md.push(`<sub>${Math.round(t.ms)} ms, ${t.calls} Claude calls${t.onboarding ? ', onboarding' : ''}${t.error ? `, ERROR: ${t.error}` : ''}</sub>`, '');
}
writeFileSync(join(outDir, 'transcripts.md'), md.join('\n'));
log(`wrote ${outDir}`);
process.exit(0);
