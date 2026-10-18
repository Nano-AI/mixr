// Compare two revisions of the backend on matching accuracy, reply quality and latency/tokens.
//   npm run eval -- --base origin/main --head HEAD [--env /abs/path/.env.eval] [--offline] [--yes] [--keep]
// Each ref is checked out into a temporary git worktree under the OS temp dir and measured by run.ts with its own
// throwaway DB. Keys come only from the environment or the --env file (default ./.env.eval); `.env` is never read,
// because the app's real one points at live Photon. Writes scripts/eval/out/report.md.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const flag = (k: string): boolean => argv.includes(`--${k}`);
const opt = (k: string): string | undefined => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const base = opt('base') ?? 'origin/main';
const head = opt('head') ?? 'HEAD';
const here = import.meta.dirname;
const outRoot = join(here, 'out');
const git = (...a: string[]): string => execFileSync('git', a, { encoding: 'utf8' }).trim();
const top = git('rev-parse', '--show-toplevel');

const envFile = resolve(opt('env') ?? '.env.eval');
if (/(^|\/)\.env$/.test(envFile)) throw new Error('refusing to load .env (live config); put eval keys in .env.eval');
if (existsSync(envFile)) process.loadEnvFile(envFile); // never printed; only the allowlisted keys below are forwarded
const offline = flag('offline');
const hasOpenai = !offline && !!process.env.OPENAI_API_KEY;
const hasClaude = !offline && !!process.env.ANTHROPIC_API_KEY;
console.log(`keys: ANTHROPIC_API_KEY ${hasClaude ? 'set' : 'missing'}, OPENAI_API_KEY ${hasOpenai ? 'set' : 'missing'}${existsSync(envFile) ? ` (loaded ${envFile})` : ''}`);
if (!hasClaude) console.log('  Claude: skipped (rerank, reply quality, latency/tokens). Set ANTHROPIC_API_KEY to measure them.');
if (!hasOpenai) console.log('  Embeddings: deterministic fake vectors (bag-of-words hash). Set OPENAI_API_KEY for real retrieval numbers.');

// ---- cost estimate before any real call (per revision): rerank per query + ~3 agent/pipeline calls per user turn.
const queries = JSON.parse(readFileSync(join(here, 'queries.json'), 'utf8')) as { type: string }[];
const convs = JSON.parse(readFileSync(join(here, 'conversations.json'), 'utf8')) as { turns: string[] }[];
const userTurns = convs.reduce((a, c) => a + c.turns.filter((t) => !t.startsWith('@')).length, 0);
const EST = { rerankIn: 5000, rerankOut: 700, turnCalls: 3, callIn: 12000, callOut: 300 }; // tune: rough, uncached
const perRev = hasClaude
  ? ((queries.length * EST.rerankIn + userTurns * EST.turnCalls * EST.callIn) * 0.1 + (queries.length * EST.rerankOut + userTurns * EST.turnCalls * EST.callOut) * 0.5) / 1e6
  : 0;
const estimate = 2 * perRev + (hasOpenai ? 0.01 : 0);
console.log(`estimated cost: ~$${estimate.toFixed(2)} for both revisions (${queries.length} queries, ${userTurns} user turns each)`);
if (estimate > 1 && !flag('yes')) {
  console.log('over $1: re-run with --yes to proceed');
  process.exit(1);
}

// ---- worktrees
const tmp = mkdtempSync(join(tmpdir(), 'mixr-eval-'));
const nodeModules = (() => {
  for (let d = top; d !== dirname(d); d = dirname(d)) if (existsSync(join(d, 'node_modules', 'tsx'))) return join(d, 'node_modules');
  return null;
})();
const lock = (dir: string) => (existsSync(join(dir, 'package-lock.json')) ? readFileSync(join(dir, 'package-lock.json'), 'utf8') : '');

type Rev = { role: 'base' | 'head'; ref: string; sha: string; label: string; dir: string; out: string; ok: boolean };
const revs: Rev[] = (['base', 'head'] as const).map((role) => {
  const ref = role === 'base' ? base : head;
  const sha = git('rev-parse', '--verify', `${ref}^{commit}`);
  const label = `${role}-${sha.slice(0, 7)}`;
  return { role, ref, sha, label, dir: join(tmp, role), out: join(outRoot, label), ok: false };
});

try {
  for (const r of revs) {
    git('worktree', 'add', '--quiet', '--detach', r.dir, r.sha);
    // Same lockfile as this checkout: reuse its node_modules. Otherwise install the revision's own.
    if (nodeModules && lock(r.dir) === lock(top)) symlinkSync(nodeModules, join(r.dir, 'node_modules'), 'dir');
    else execFileSync('npm', ['ci', '--no-audit', '--no-fund'], { cwd: r.dir, stdio: 'inherit' });
    console.log(`\n== ${r.label} (${r.ref}) ==`);
    // A clean env: the throwaway DB, TRANSPORT=sim, no Photon or email credentials, keys only when present.
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      TMPDIR: tmpdir(),
      TZ: 'America/Los_Angeles',
      TRANSPORT: 'sim',
      DB_DIR: join(tmp, `${r.role}-db`),
      MIXR_FAKE: hasClaude || hasOpenai ? '0' : '1',
      EVAL_FAKE_EMBED: hasOpenai ? '0' : '1',
      PIPELINE_LLM: hasClaude ? 'on' : 'off',
      CLAUDE_DAILY_REQUEST_LIMIT: '1000',
    };
    for (const k of ['ANTHROPIC_MODEL', 'ANTHROPIC_WORKSPACE_ID', 'EMBEDDING_MODEL', 'EMBEDDING_DIMS']) if (process.env[k]) env[k] = process.env[k]!;
    if (hasClaude) env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY!;
    if (hasOpenai) env.OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
    const res = spawnSync(process.execPath, ['--import', 'tsx', join(here, 'run.ts'), '--root', r.dir, '--out', r.out, '--label', r.label], { cwd: r.dir, env, stdio: 'inherit' });
    r.ok = res.status === 0;
    if (!r.ok) console.log(`${r.label}: eval failed (exit ${res.status})`);
  }
} finally {
  if (!flag('keep')) {
    for (const r of revs) if (existsSync(r.dir)) spawnSync('git', ['worktree', 'remove', '--force', r.dir]);
    rmSync(tmp, { recursive: true, force: true });
  } else console.log(`kept ${tmp}`);
}

// ---- report
const load = (r: Rev): any => (r.ok ? JSON.parse(readFileSync(join(r.out, 'results.json'), 'utf8')) : null);
const [B, H] = revs.map(load);
const get = (o: any, path: string): number | undefined => path.split('.').reduce((a, k) => a?.[k], o);
const fmt = (v: number | undefined): string => (v === undefined || v === null ? 'n/a' : Number.isInteger(v) ? String(v) : v.toFixed(3));
const row = (name: string, path: string) => {
  const b = get(B, path);
  const h = get(H, path);
  const d = typeof b === 'number' && typeof h === 'number' ? h - b : undefined;
  return `| ${name} | ${fmt(b)} | ${fmt(h)} | ${d === undefined ? '' : (d > 0 ? '+' : '') + fmt(d)} |`;
};
const table = (rows: [string, string][]) => ['| metric | base | head | delta |', '|---|---:|---:|---:|', ...rows.map(([n, p]) => row(n, p)), ''];
const mode = (x: any) => (x ? `embeddings ${x.mode.fakeEmbeddings ? 'FAKE' : 'openai'}, Claude ${x.mode.claude ? 'on' : 'off'}, hybrid recall ${x.retrieval.hybrid ? 'yes' : 'no'}` : 'FAILED');

const md: string[] = [
  '# mixr eval report',
  '',
  `- base: \`${base}\` ${revs[0].sha.slice(0, 7)} (${mode(B)})`,
  `- head: \`${head}\` ${revs[1].sha.slice(0, 7)} (${mode(H)})`,
  `- ${queries.length} labelled queries (${queries.filter((x) => x.type === 'exact').length} exact, ${queries.filter((x) => x.type === 'semantic').length} semantic), ${convs.length} scripted conversations`,
  '',
];
if (!hasOpenai) md.push('> Retrieval used **deterministic fake embeddings** (bag-of-words hash, no OPENAI_API_KEY). The vector side is a lexical proxy, so these numbers are not real semantic recall; a BM25/hybrid lexical side still measures properly.', '');
md.push('## 1. Retrieval', '');
for (const split of ['all', 'exact', 'semantic']) {
  md.push(`### ${split}`, '');
  const rows: [string, string][] = [
    ['recall@10 (recall stage)', `retrieval.${split}.recall10`],
    ['recall@40 (recall stage)', `retrieval.${split}.recall40`],
    ['MRR (recall stage)', `retrieval.${split}.mrr`],
  ];
  if (hasClaude) rows.push(['precision@5 (rerank)', `retrieval.${split}.rrP5`], ['recall@5 (rerank)', `retrieval.${split}.rrRecall5`], ['MRR (rerank)', `retrieval.${split}.rrMrr`]);
  md.push(...table(rows));
}
if (!hasClaude) md.push('_Rerank skipped: no ANTHROPIC_API_KEY._', '');

md.push('## 2. Reply quality', '');
if (!hasClaude) md.push('_Skipped: no ANTHROPIC_API_KEY. The conversations ran on the fake agent only as a plumbing smoke test._', '');
else
  md.push(
    ...table([
      ['agent turns', 'conversations.turns'],
      ['chars per turn (mean)', 'conversations.chars.mean'],
      ['chars per turn (p90)', 'conversations.chars.p90'],
      ['bubbles per turn (mean)', 'conversations.bubbles.mean'],
      ['bubbles per turn (p90)', 'conversations.bubbles.p90'],
      ['questions per turn (mean)', 'conversations.questions.mean'],
      ['questions per turn (p90)', 'conversations.questions.p90'],
      ['starts with a capital (rate)', 'conversations.capitalRate'],
      ['restates the profile (rate)', 'conversations.restateRate'],
      ['narrating sentences per turn (mean)', 'conversations.narration.mean'],
      ['turns with narration (rate)', 'conversations.narrationRate'],
      ['duplicate bubbles (total)', 'conversations.dupes'],
      ['turns with >1 bubble', 'conversations.multiBubbleTurns'],
      ['turns with no reply', 'conversations.silentTurns'],
      ['errors', 'conversations.errors'],
    ]),
    'Transcripts side by side: [transcripts.md](transcripts.md); per revision: `out/<rev>/transcripts.md`.',
    '',
  );

md.push('## 3. Latency and tokens', '');
if (!hasClaude) md.push('_Skipped: no ANTHROPIC_API_KEY._', '');
else
  md.push(
    ...table([
      ['Claude calls (total)', 'llm.claude.calls'],
      ['failed calls', 'llm.claude.failed'],
      ['wall ms per call (mean)', 'llm.claude.msMean'],
      ['wall ms per call (p90)', 'llm.claude.msP90'],
      ['input tokens (total)', 'llm.claude.input'],
      ['cache_creation tokens (total)', 'llm.claude.cacheWrite'],
      ['cache_read tokens (total)', 'llm.claude.cacheRead'],
      ['output tokens (total)', 'llm.claude.output'],
      ['agent calls', 'llm.agentCalls.calls'],
      ['pipeline calls (rerank, canonicalize, ...)', 'llm.pipelineCalls.calls'],
      ['Claude calls per user turn (mean)', 'conversations.callsPerTurn.mean'],
      ['Claude calls per user turn (p90)', 'conversations.callsPerTurn.p90'],
      ['turn wall ms (mean)', 'conversations.turnMs.mean'],
      ['turn wall ms (p90)', 'conversations.turnMs.p90'],
      ['input tokens per turn', 'llm.perTurn.input'],
      ['cache_creation per turn', 'llm.perTurn.cacheWrite'],
      ['cache_read per turn', 'llm.perTurn.cacheRead'],
      ['output tokens per turn', 'llm.perTurn.output'],
      ['embedding tokens', 'llm.embed.tokens'],
      ['estimated cost (USD)', 'llm.costUsd'],
    ]),
  );

// Per-query retrieval detail, so a regression can be traced to the query.
if (B && H) {
  md.push('## Per query (recall stage MRR / recall@10)', '', '| type | query | base | head |', '|---|---|---:|---:|');
  B.retrieval.perQuery.forEach((b: any, i: number) => {
    const h = H.retrieval.perQuery[i];
    md.push(`| ${b.type} | ${b.text} | ${fmt(b.mrr)} / ${fmt(b.recall10)} | ${fmt(h?.mrr)} / ${fmt(h?.recall10)} |`);
  });
  md.push('');

  // Side-by-side transcripts: each user text, then both revisions' replies.
  const t = ['# Transcripts, base vs head', '', `base ${revs[0].label}, head ${revs[1].label}`, ''];
  const byKey = (x: any) => new Map<string, any>(x.turns.map((tt: any, i: number) => [`${tt.conv}#${i}`, tt]));
  const hm = byKey(H);
  let cur = '';
  B.turns.forEach((b: any, i: number) => {
    if (b.conv !== cur) t.push(`\n## ${(cur = b.conv)}\n`);
    const h = hm.get(`${b.conv}#${i}`);
    t.push(`**user:** ${b.text}`, '', `- **base:** ${b.bubbles.join(' ⏎ ') || '_(none)_'}`, `- **head:** ${h?.bubbles.join(' ⏎ ') || '_(none)_'}`, '');
  });
  writeFileSync(join(outRoot, 'transcripts.md'), t.join('\n'));
}

mkdirSync(outRoot, { recursive: true });
writeFileSync(join(outRoot, 'report.md'), md.join('\n'));
console.log(`\nwrote ${join(outRoot, 'report.md')}`);
process.exit(B && H ? 0 : 1);
