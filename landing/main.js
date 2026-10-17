import { animate, createTimeline, onScroll, utils } from 'https://cdn.jsdelivr.net/npm/animejs@4.5.0/dist/bundles/anime.esm.min.js';

const API = location.hostname.endsWith('joinmixr.club') ? 'https://api.joinmixr.club' : 'http://localhost:3000';
const SMS = document.body.dataset.sms; // set data-sms="+1..." on <body> to offer a text-us fallback

const $ = (s) => document.querySelector(s);
const phone = $('#phone');
const chatView = $('.chat');
const rail = $('#rail');
const compose = $('#compose');
const typed = $('#typed');
const sendBtn = compose.querySelector('.send');
const keypad = $('#keypad');
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

// phone depth: stacked rounded slices read as a machined titanium edge
const body = phone.querySelector('.body');
const DEPTH = 15;
for (let i = 1; i <= DEPTH; i++) {
  const l = document.createElement('i');
  l.className = i === DEPTH ? 'layer back' : 'layer';
  l.style.setProperty('--z', -i * 2);
  body.prepend(l);
}

// fit the native-size phone into the viewport
const fit = () => phone.style.setProperty('--s', Math.min(1, (innerWidth * 0.88) / 426, (innerHeight * 0.82) / 898));
fit();
addEventListener('resize', fit);

// live clock and date, like a real lock screen
const tick = () => {
  const now = new Date();
  const t = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(/\s?[AP]M/, '');
  document.querySelectorAll('[data-clock]').forEach((el) => (el.textContent = t));
  $('[data-date]').textContent = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
};
tick();
setInterval(tick, 15000);

// ── keypad: iOS phone pad, also driven by the physical keyboard ──
const KEYS = [['1', ''], ['2', 'ABC'], ['3', 'DEF'], ['4', 'GHI'], ['5', 'JKL'], ['6', 'MNO'], ['7', 'PQRS'], ['8', 'TUV'], ['9', 'WXYZ'], ['', ''], ['0', '+'], ['del', '']];
const DEL_ICON = '<svg viewBox="0 0 28 20" width="27" aria-hidden="true"><path d="M9 1h15a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H9L1 10Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="m13 6 8 8m0-8-8 8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';
for (const [k, sub] of KEYS) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = k === 'del' ? 'key del' : k ? 'key' : 'key blank';
  if (k === 'del') {
    b.innerHTML = DEL_ICON;
    b.setAttribute('aria-label', 'Delete');
  } else if (k) {
    b.innerHTML = `${k}<small>${sub}</small>`;
    b.setAttribute('aria-label', k);
  } else b.tabIndex = -1;
  b.dataset.k = k;
  keypad.append(b);
}

let digits = '';
let busy = false;
let kbOn = false;
// (425) 340-5583, built as you type
const fmt = (d) => (d.length < 4 ? (d ? `(${d}` : '') : d.length < 7 ? `(${d.slice(0, 3)}) ${d.slice(3)}` : `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`);
const render = () => {
  typed.textContent = fmt(digits);
  typed.toggleAttribute('data-empty', !digits);
  sendBtn.disabled = digits.length !== 10;
};

function press(k) {
  const btn = keypad.querySelector(`[data-k="${k}"]`);
  btn.classList.add('down');
  setTimeout(() => btn.classList.remove('down'), 150);
  if (!reduced) animate(btn, { scale: [0.9, 1], duration: 260, ease: 'outBack(2)' });
  if (k === 'del') digits = digits.slice(0, -1);
  else if (!digits && (k === '0' || k === '1')) {
    // US area codes never start with 0 or 1
    if (!reduced) animate('.field', { x: [0, -6, 6, -3, 0], duration: 300 });
    return;
  } else if (digits.length < 10) digits += k;
  render();
}

keypad.addEventListener('click', (e) => {
  const k = e.target.closest('.key')?.dataset.k;
  if (k && !busy) press(k);
});
addEventListener('keydown', (e) => {
  if (busy || e.metaKey || e.ctrlKey || e.altKey) return;
  // typing a digit anywhere jumps to the phone and opens the pad, so the keyboard always works
  if (/^\d$/.test(e.key) && !kbOn) {
    const end = $('#scroll');
    scrollTo({ top: end.offsetTop + end.offsetHeight - innerHeight, behavior: reduced ? 'auto' : 'smooth' });
    openKeypad();
  }
  if (!kbOn) return;
  if (/^\d$/.test(e.key)) press(e.key);
  else if (e.key === 'Backspace') press('del');
  else if (e.key === 'Enter') compose.requestSubmit();
  else return;
  e.preventDefault();
});

function openKeypad() {
  if (kbOn) return;
  kbOn = true;
  chatView.classList.add('kb');
  keypad.style.height = 'auto';
  const h = keypad.offsetHeight;
  if (reduced) return;
  keypad.style.height = '0px';
  animate(keypad, { height: [0, h], duration: 480, ease: 'outQuart' });
}
function closeKeypad() {
  kbOn = false;
  const done = () => chatView.classList.remove('kb');
  if (reduced) return (keypad.style.height = '0px'), done();
  animate(keypad, { height: 0, duration: 380, ease: 'inOutQuad', onComplete: done });
}

// ── scroll story ──
const steps = [...rail.querySelectorAll('[data-step]')];
// hidden steps collapse via negative margin so the thread grows from the bottom like iOS
const shown = steps.map((el) => parseFloat(getComputedStyle(el).marginTop));
const hidden = steps.map((el) => -el.offsetHeight);
const origin = (el) => (el.classList.contains('me') || el.classList.contains('receipt') ? '100% 100%' : '0% 100%');

if (reduced) {
  utils.set(['.off', '.lock', '.lede'], { opacity: 0 });
  utils.set('.statusbar', { color: '#000' });
  utils.set(['.homebar', '#hint'], { opacity: 1 });
  steps.filter((el) => el.hasAttribute('data-typing')).forEach((el) => el.remove());
  openKeypad();
} else {
  steps.forEach((el, i) => {
    el.style.transformOrigin = origin(el);
    utils.set(el, { opacity: 0, marginTop: hidden[i], scale: 0.6 });
  });
  utils.set('[data-notif]', { opacity: 0, y: -40, scale: 0.94 });
  utils.set('.statusbar', { opacity: 0 });

  // the conversation only moves forward: bubbles that appeared stay, even when you scroll back up
  const chat = createTimeline({ autoplay: false });
  const at = [0, 80, 130, 180, 220, 280, 305, 350, 390, 440];
  steps.forEach((el, i) => {
    chat.add(el, { opacity: [0, 1], marginTop: [hidden[i], shown[i]], scale: [0.6, 1], duration: 40, ease: 'outBack(1.4)' }, at[i]);
    if (el.hasAttribute('data-typing')) chat.add(el, { opacity: [1, 0], marginTop: [shown[i], hidden[i]], duration: 30, ease: 'outQuad' }, at[i + 1] - 5);
  });
  let reached = 0;

  createTimeline({
    defaults: { ease: 'outQuad', duration: 60 },
    autoplay: onScroll({ target: '#scroll', enter: 'top top', leave: 'bottom bottom', sync: 0.25 }),
    onUpdate: (self) => {
      const p = utils.clamp((self.currentTime - 510) / 440, 0, 1);
      if (p <= reached) return;
      reached = p;
      chat.seek(p * chat.duration);
      if (p === 1) openKeypad();
    },
  })
    // pick the phone up off the table
    .add(phone, { rotateX: [62, 0], rotateZ: [-24, 0], rotateY: [14, 0], y: [110, 0], duration: 300, ease: 'inOutCubic' }, 0)
    .add('.lede', { opacity: [1, 0], y: [0, -50], duration: 180 }, 0)
    .add('.screen', { '--sheen': ['-60%', '60%'], duration: 520, ease: 'linear' }, 0)
    // wake, notify, swipe up to unlock
    .add('.off', { opacity: [1, 0], duration: 50 }, 260)
    .add('.statusbar', { opacity: [0, 1], duration: 40 }, 260)
    .add('[data-notif]', { opacity: [0, 1], y: [-40, 0], scale: [0.94, 1], duration: 70, ease: 'outBack' }, 320)
    .add('.swipe-text', { opacity: [0.85, 0.35, 0.85], duration: 60, ease: 'inOutSine' }, 390)
    .add('.touch', { opacity: [0, 1], scale: [1.3, 1], y: [-40, -40], duration: 25 }, 420)
    .add('.touch', { y: [-40, -520], opacity: [1, 0], duration: 70, ease: 'inQuad' }, 445)
    .add('.lock', { y: ['0%', '-100%'], duration: 70, ease: 'inOutQuad' }, 445)
    .add('.chat', { scale: [0.92, 1], opacity: [0.4, 1], duration: 70, ease: 'outQuad' }, 450)
    .add('.statusbar', { color: ['#fff', '#000'], duration: 20 }, 490)
    .add('.homebar', { opacity: [0, 1], duration: 20 }, 495)
    .add('#hint', { opacity: [0, 1], y: [10, 0], duration: 40 }, 950);
}

// ── the real sign-up ──
function bubble(cls, content) {
  const p = document.createElement('p');
  p.className = cls;
  if (content instanceof Node) p.append(content);
  else p.textContent = content;
  p.style.transformOrigin = origin(p);
  rail.append(p);
  if (!reduced) animate(p, { opacity: [0, 1], scale: [0.6, 1], duration: 380, ease: 'outBack(1.4)' });
  return p;
}

const say = async (content) => {
  const dots = bubble('typing them', '');
  dots.innerHTML = '<i></i><i></i><i></i>';
  await new Promise((r) => setTimeout(r, reduced ? 0 : 900));
  dots.remove();
  return bubble('b them', content);
};

compose.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (digits.length !== 10 || busy) return;
  busy = true;
  const number = digits;
  rail.querySelectorAll('.receipt').forEach((r) => r.remove());
  bubble('b me', fmt(number));
  digits = '';
  render();

  let reply;
  let ok = false;
  try {
    const res = await fetch(`${API}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: `+1${number}` }),
    });
    ok = res.ok;
    reply = ok
      ? 'Just texted you. Reply YES there to get started.'
      : (await res.json().catch(() => ({}))).error ?? "That didn't go through. Try again in a minute.";
  } catch {
    reply = "I can't reach my phone right now. Try again in a minute.";
  }
  if (ok) {
    bubble('receipt', 'Delivered');
    closeKeypad();
  }
  await say(reply);
  if (!ok && SMS) {
    const a = document.createElement('a');
    a.href = `sms:${SMS}&body=hi`;
    a.textContent = 'Or text me hi directly.';
    await say(a);
  }
  busy = false;
});

render();
