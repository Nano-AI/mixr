// Records the dashboard shots for the demo deck against a throwaway sim backend (sim-server.mjs: TRANSPORT=sim,
// temp DB, 127.0.0.1, random ADMIN_TOKEN, keys from .env.eval). Seeds the invented demo students, then:
//   05-host      a board-game fan texts "host a catan night..."; the event's invites go out in rounds
//   06-matching  a tennis player asks for a partner; the Trace tab shows recall (vector + keyword) and the rerank
//   08-events    "what's going on this week?" answered from imported UW campus events (--uw-events N to import)
//   node scripts/demo/record-dashboard.mjs [05-host] [06-matching] [08-events] [--port 8790] [--uw-events 4] [--headed]
// Real Claude/OpenAI calls: roughly 3-6 per shot plus one per imported event; capped by CLAUDE_DAILY_REQUEST_LIMIT.
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { injectPointer, launchOpts, loadPlaywright, moveClick } from './record-web.mjs';
import { startSim } from './sim-server.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const RAW = join(ROOT, 'demo/raw');
const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(`--${k}`) ? args[args.indexOf(`--${k}`) + 1] : d);
const shots = args.filter((a, i) => /^\d\d-/.test(a) && !args[i - 1]?.startsWith('--'));
const want = shots.length ? shots : ['05-host', '06-matching', ...(Number(opt('uw-events', 0)) ? ['08-events'] : [])];
const VIEW = { width: 1280, height: 800 }; // 1:1 with the 720p-ish deck clip, so dashboard text stays legible

async function typeInto(page, locator, text) {
  await moveClick(page, locator);
  await locator.pressSequentially(text, { delay: 38 });
  await page.waitForTimeout(350);
}

// Open a student's phone pane through the "Act as..." search, like an operator would.
async function actAs(page, name) {
  const search = page.locator('.picker-input');
  await typeInto(page, search, name.split(' ')[0]);
  const item = page.locator('.picker-item', { hasText: name }).first();
  await item.waitFor();
  await moveClick(page, item);
  await page.locator('.phone .phone-input .input').last().waitFor();
  await page.waitForTimeout(700);
}

// Send a text from the open pane and wait until mixr has answered (the input is disabled while it replies).
async function text(page, msg, { timeout = 90_000 } = {}) {
  const input = page.locator('.phone .phone-input .input').last();
  await typeInto(page, input, msg);
  await moveClick(page, page.locator('.phone .send-btn').last(), { pause: 150 });
  await page.waitForTimeout(800);
  await page.waitForFunction(() => {
    const i = [...document.querySelectorAll('.phone .phone-input .input')].at(-1);
    return i && !i.disabled && !document.querySelector('.phone .bubble.typing');
  }, null, { timeout, polling: 250 });
  await page.waitForTimeout(1200);
}

const tab = (page, name) => moveClick(page, page.getByRole('tab', { name: new RegExp(`^${name}`) }));

async function shoot(browser, sim, name, body) {
  const dir = join(RAW, `.pw-${name}`);
  const context = await browser.newContext({ viewport: VIEW, recordVideo: { dir, size: VIEW } });
  await context.request.post(`${sim.url}/auth/login`, { data: { token: sim.token } });
  await context.addInitScript(() => {
    // Clean layout per shot: no panes left open, a wide inspector. Wrapped: storage can throw.
    try {
      if (!sessionStorage.getItem('demo-init')) {
        sessionStorage.setItem('demo-init', '1');
        localStorage.setItem('mixr.panes', '[]');
        localStorage.setItem('mixr.inspectorPct', '52');
        localStorage.setItem('mixr.collapsed', 'false');
        localStorage.setItem('mixr.tab', '"events"');
      }
    } catch {}
  });
  const page = await context.newPage();
  await page.goto(`${sim.url}/dashboard/`, { waitUntil: 'load' });
  await page.locator('.picker-input').waitFor();
  await injectPointer(page, 'arrow');
  await page.mouse.move(640, 420);
  await page.waitForTimeout(1200);
  try {
    await body(page);
  } finally {
    const video = page.video();
    await context.close();
    const out = join(RAW, `${name}.webm`);
    copyFileSync(await video.path(), out);
    rmSync(dir, { recursive: true, force: true });
    console.log('raw:', out);
  }
}

const SHOTS = {
  // Marcus (Catan, big group game nights) hosts; round 1 goes out at once, the next after the timeout (+6h).
  '05-host': async (page) => {
    await actAs(page, 'Marcus Johnson');
    await text(page, 'host a catan night friday 7pm at the hub, 6 people');
    await tab(page, 'Events');
    const ev = page.locator('.tab-body').getByText(/catan/i).first();
    await ev.waitFor({ timeout: 30_000 });
    await moveClick(page, ev);
    await page.locator('.wave').first().waitFor({ timeout: 60_000 });
    await page.waitForTimeout(1500);
    await page.locator('.wave').first().hover();
    await page.waitForTimeout(1500);
    await moveClick(page, page.getByRole('button', { name: '+6h' }));
    await page.locator('.wave').nth(1).waitFor({ timeout: 90_000 });
    await page.locator('.wave').nth(1).scrollIntoViewIfNeeded();
    await page.locator('.wave').nth(1).hover();
    await page.waitForTimeout(3000);
  },
  // Jordan (USTA 3.5) asks for a hitting partner; then the matching trace: recall hits, then the rerank's picks.
  '06-matching': async (page) => {
    await actAs(page, 'Jordan Alvarez');
    await text(page, 'anyone down for tennis this week? looking for a hitting partner');
    await tab(page, 'Trace');
    const recall = page.locator('.trace.k-recall .trace-head').first();
    await recall.waitFor({ timeout: 30_000 });
    await moveClick(page, recall);
    await page.waitForTimeout(2500);
    const rerank = page.locator('.trace.k-rerank .trace-head').first();
    if (await rerank.count()) {
      await moveClick(page, recall); // fold recall so the rerank sits up top
      await page.waitForTimeout(400);
      await moveClick(page, rerank);
      await page.waitForTimeout(3000);
    }
  },
  '08-events': async (page) => {
    await actAs(page, 'Priya Raman');
    await text(page, "what's going on this week?");
    await page.waitForTimeout(2500);
  },
};

mkdirSync(RAW, { recursive: true });
const sim = await startSim({ port: Number(opt('port', 8790)), uwEvents: Number(opt('uw-events', 0)) });
console.log(`sim server ${sim.url} (data ${sim.tmp})`);
try {
  const seeded = await sim.api('/seed', {});
  console.log('seeded:', seeded.users);
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch(launchOpts(args.includes('--headed')));
  try {
    for (const name of want) {
      if (!SHOTS[name]) throw new Error(`unknown shot ${name}`);
      await shoot(browser, sim, name, SHOTS[name]).catch((e) => console.error(`${name} failed:`, e.message));
    }
  } finally {
    await browser.close();
  }
  const state = await sim.api('/state');
  const calls = state?.usage;
  console.log('llm usage:', JSON.stringify(calls ?? 'see dashboard top bar'));
} finally {
  sim.stop();
}
