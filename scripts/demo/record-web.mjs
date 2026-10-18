// Records the landing-page sign-up for the demo deck: 01-signup-desktop (1440x900, mouse) and 02-signup-phone
// (390x844, touch). Serves landing/ on a free local port with ?mock=ok, so the join is faked and nothing is ever
// sent to a backend. Raw videos land in demo/raw/; cut them with clip.sh (commands printed at the end).
//   node scripts/demo/record-web.mjs [desktop|phone] [--headed]
// Needs Playwright: `npm i --no-save playwright` once, or PLAYWRIGHT=/path/to/node_modules/playwright.
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '../..');
const RAW = join(ROOT, 'demo/raw');
const NUMBER = '4255550142'; // fictional 555-01xx
const which = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const headed = process.argv.includes('--headed');

export async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    if (!process.env.PLAYWRIGHT) throw new Error('playwright not found: npm i --no-save playwright, or set PLAYWRIGHT=/path/to/node_modules/playwright');
    const m = await import(pathToFileURL(join(process.env.PLAYWRIGHT, 'index.mjs')).href);
    return m.default ?? m;
  }
}

// New headless on the real GPU (Metal): ~45fps with the WebGL background. Old headless falls back to
// SwiftShader at ~4fps, which makes every animation in the video stutter.
export const launchOpts = (headed = false) => ({ headless: !headed, channel: 'chromium', args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });

const freePort = (from) =>
  new Promise((ok) => {
    const s = createServer().once('error', () => ok(freePort(from + 1)));
    s.listen(from, '127.0.0.1', () => s.close(() => ok(from)));
  });

// Arrow cursor (desktop) or a touch dot (phone) drawn into the page, since headless video has no pointer.
export async function injectPointer(page, kind = 'arrow') {
  await page.evaluate((kind) => {
    if (document.getElementById('demo-cursor')) return;
    const c = document.createElement('div');
    c.id = 'demo-cursor';
    c.innerHTML =
      kind === 'arrow'
        ? '<svg width="28" height="28" viewBox="0 0 24 24"><path d="M5 3L19 12L12 13L9 20L5 3Z" fill="white" stroke="black" stroke-width="1.5" stroke-linejoin="round"/></svg>'
        : '';
    c.style.cssText =
      kind === 'arrow'
        ? 'position:fixed;z-index:2147483647;pointer-events:none;left:-40px;top:-40px;filter:drop-shadow(1px 1px 2px rgba(0,0,0,.35))'
        : 'position:fixed;z-index:2147483647;pointer-events:none;left:-80px;top:-80px;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;background:rgba(120,120,128,.35);border:2px solid rgba(255,255,255,.85);opacity:0;transition:opacity .25s,transform .25s';
    document.body.appendChild(c);
    const st = document.createElement('style');
    st.textContent = 'html.cursoring #demo-cursor{display:none}'; // the landing's own "scroll" pill is the cursor there
    document.head.appendChild(st);
    const at = (x, y) => ((c.style.left = x + 'px'), (c.style.top = y + 'px'));
    addEventListener('mousemove', (e) => at(e.clientX, e.clientY), true);
    addEventListener('touchstart', (e) => {
      at(e.touches[0].clientX, e.touches[0].clientY);
      c.style.opacity = '1';
      c.style.transform = 'scale(.85)';
    }, true);
    addEventListener('touchend', () => setTimeout(() => ((c.style.opacity = '0'), (c.style.transform = 'scale(1)')), 180), true);
  }, kind);
}

// Glide the mouse to an element's center, then click (never teleport).
export async function moveClick(page, locator, { steps = 14, pause = 220 } = {}) {
  const box = await locator.boundingBox();
  if (!box) throw new Error(`not visible: ${locator}`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps });
  await page.waitForTimeout(pause);
  await page.mouse.down();
  await page.waitForTimeout(70);
  await page.mouse.up();
}

async function tap(page, locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error(`not visible: ${locator}`);
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
}

async function record(browser, base, kind) {
  const desktop = kind === 'desktop';
  const viewport = desktop ? { width: 1440, height: 900 } : { width: 390, height: 844 };
  const dir = join(RAW, `.pw-${kind}`);
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: desktop ? 1 : 2,
    isMobile: !desktop,
    hasTouch: !desktop,
    userAgent: desktop ? undefined : 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    recordVideo: { dir, size: viewport }, // frames are CSS-pixel sized; 844 tall covers the 720p phone clip
  });
  const page = await context.newPage();
  await page.goto(`${base}/?mock=ok`, { waitUntil: 'networkidle' });
  await injectPointer(page, desktop ? 'arrow' : 'touch');
  await page.waitForTimeout(1600); // hero settles

  // One scroll / tap starts the story and it plays itself to the number pad. Where it stops on its own (the
  // autoplay can stall between two slides at the same zoom), scroll / tap again like a visitor would.
  const nudge = async () => (desktop ? page.mouse.wheel(0, 120) : page.touchscreen.tap(195, 640));
  if (desktop) {
    await page.mouse.move(900, 640, { steps: 12 });
    await page.waitForTimeout(400);
  }
  await nudge();
  const slide = () => page.evaluate(() => [...document.querySelectorAll('#dots button')].findIndex((d) => d.hasAttribute('aria-current')));
  const keypadUp = () => page.evaluate(() => document.querySelector('#hint')?.classList.contains('on'));
  for (let last = -1, still = 0; !(await keypadUp()); ) {
    await page.waitForTimeout(200);
    const s = await slide();
    still = s === last ? still + 200 : 0;
    last = s;
    if (still >= 1600 && s < 5) (await nudge(), (still = 0));
  }
  await page.waitForTimeout(900);

  for (const d of NUMBER) {
    const key = page.locator(`#keypad .key[data-k="${d}"]`);
    if (desktop) await moveClick(page, key, { steps: 6, pause: 90 });
    else await tap(page, key);
    await page.waitForTimeout(desktop ? 140 : 230);
  }
  await page.waitForTimeout(500);
  const send = page.locator('#compose .send');
  if (desktop) await moveClick(page, send);
  else await tap(page, send);
  await page.locator('.line').waitFor({ state: 'visible', timeout: 15000 });
  if (desktop) await page.mouse.move(viewport.width - 120, viewport.height - 80, { steps: 20 }); // out of the card's way
  await page.waitForTimeout(3500); // end on the contact card

  const video = page.video();
  await context.close();
  const out = join(RAW, desktop ? '01-signup-desktop.webm' : '02-signup-phone.webm');
  copyFileSync(await video.path(), out);
  rmSync(dir, { recursive: true, force: true });
  console.log('raw:', out);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  mkdirSync(RAW, { recursive: true });
  const port = await freePort(8797);
  const srv = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1', '-d', join(ROOT, 'landing')], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 800));
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch(launchOpts(headed));
  try {
    for (const kind of which.length ? which : ['desktop', 'phone']) await record(browser, `http://127.0.0.1:${port}`, kind);
  } finally {
    await browser.close();
    srv.kill();
  }
  console.log('\nnext: scripts/demo/clip.sh demo/raw/01-signup-desktop.webm 01-signup-desktop --in <s> --fast <a-b:x>');
  console.log('      scripts/demo/clip.sh demo/raw/02-signup-phone.webm 02-signup-phone --phone --in <s> --fast <a-b:x>');
}
