// A throwaway local backend for recording the dashboard: TRANSPORT=sim (nothing ever leaves the server), a fresh
// DB in a temp dir, 127.0.0.1 only, a random ADMIN_TOKEN. Keys come from .env.eval the same way scripts/eval does
// (never .env, which points at production; values are never printed). The server runs with a temp dir as cwd so
// config.ts can't pick up a .env from the checkout.
//   node scripts/demo/sim-server.mjs [--port 8790] [--uw-events 12]   (runs until Ctrl-C, prints URL + token)
//   --uw-events N: before starting, import the next N upcoming UW campus events (one Claude HyDE call each).
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '../..');

export async function startSim({ port = 8790, uwEvents = 0, claudeLimit = 60 } = {}) {
  const envFile = resolve(ROOT, process.env.MIXR_EVAL_ENV ?? '.env.eval');
  const top = resolve(ROOT, '../../..', '.env.eval'); // a worktree under .claude/worktrees shares the main checkout's
  const file = existsSync(envFile) ? envFile : existsSync(top) ? top : null;
  if (file && /(^|\/)\.env$/.test(file)) throw new Error('refusing to load .env (live config)');
  if (file) process.loadEnvFile(file);
  const hasClaude = !!process.env.ANTHROPIC_API_KEY;
  const hasOpenai = !!process.env.OPENAI_API_KEY;
  console.log(`keys: ANTHROPIC_API_KEY ${hasClaude ? 'set' : 'missing'}, OPENAI_API_KEY ${hasOpenai ? 'set' : 'missing'}`);

  const tmp = mkdtempSync(join(tmpdir(), 'mixr-demo-'));
  const token = randomBytes(18).toString('base64url');
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    TMPDIR: tmpdir(),
    TZ: 'America/Los_Angeles',
    TRANSPORT: 'sim',
    DB_DIR: join(tmp, 'db'),
    PORT: String(port),
    HOST: '127.0.0.1',
    ADMIN_TOKEN: token,
    UW_CALENDAR: 'off',
    MIXR_FAKE: hasClaude || hasOpenai ? '0' : '1',
    PIPELINE_LLM: hasClaude ? 'on' : 'off',
    CLAUDE_DAILY_REQUEST_LIMIT: String(claudeLimit), // hard spend cap for the whole recording session
  };
  for (const k of ['ANTHROPIC_MODEL', 'ANTHROPIC_WORKSPACE_ID', 'EMBEDDING_MODEL', 'EMBEDDING_DIMS']) if (process.env[k]) env[k] = process.env[k];
  if (hasClaude) env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (hasOpenai) env.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  const tsx = import.meta.resolve('tsx');
  const cwd = join(tmp, 'cwd');
  mkdirSync(cwd);

  if (uwEvents > 0) {
    // Import runs in its own process before the server (PGlite is single-process). Trim the snapshot to N events.
    const script = `
      import { fetchUwEvents, importUwEvents, isStudentRelevant } from ${JSON.stringify(pathToFileURL(join(ROOT, 'src/calendar/uw.ts')).href)};
      const t = Date.now();
      const week = (await fetchUwEvents())
        .filter((e) => isStudentRelevant(e) && Date.parse(e.startsAt) > t && Date.parse(e.startsAt) < t + 7 * 864e5)
        .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
      // On camera: skip anything likely to name a real person (talks, lectures, "Title: Speaker", "A | B").
      const NAMED = /[:|]|lecture|seminar|colloquium|talk|prof\\.?\\b|dr\\.|book|author|reading|recital|concert|defense|symposium|memorial|award|visit|conversation|presents|featuring|with\\s+[A-Z]/i;
      const seen = new Set();
      const picked = week
        .filter((e) => !NAMED.test(e.title) && !seen.has(e.title.toLowerCase()) && seen.add(e.title.toLowerCase()))
        .slice(0, ${Number(uwEvents)});
      for (const e of picked) console.log('  uw event:', e.startsAt.slice(0, 16), e.title);
      const r = await importUwEvents(picked);
      console.log('uw events imported:', r.inserted);
      process.exit(0);`;
    writeFileSync(join(cwd, 'import.mts'), script);
    const r = spawnSync(process.execPath, ['--import', tsx, join(cwd, 'import.mts')], { cwd, env, stdio: 'inherit' });
    if (r.status !== 0) console.log('uw events import failed; continuing without them');
  }

  const child = spawn(process.execPath, ['--import', tsx, join(ROOT, 'src/server.ts')], { cwd, env, stdio: ['ignore', 'inherit', 'inherit'] });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`server exited (${child.exitCode})`);
    try {
      if ((await fetch(`${url}/health`)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  const api = (path, body) =>
    fetch(`${url}/api${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }).then((r) => r.json());
  return { url, token, tmp, child, api, stop: () => child.kill('SIGTERM') };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (k, d) => (process.argv.includes(`--${k}`) ? Number(process.argv[process.argv.indexOf(`--${k}`) + 1]) : d);
  const sim = await startSim({ port: arg('port', 8790), uwEvents: arg('uw-events', 0) });
  console.log(`\nsim server: ${sim.url}/dashboard/\nadmin token (local, throwaway): ${sim.token}\ndata: ${sim.tmp}`);
  process.on('SIGINT', () => (sim.stop(), process.exit(0)));
}
