import { animate, createTimeline, onScroll, utils } from 'https://cdn.jsdelivr.net/npm/animejs@4.5.0/dist/bundles/anime.esm.min.js';
import { startGlow } from './glow.js';

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
const fit = () => {
  const s = Math.min(1, (innerWidth * 0.88) / 426, (innerHeight * 0.82) / 898);
  phone.style.setProperty('--s', s);
  document.documentElement.style.setProperty('--pw', `${426 * s}px`);
};
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
const num = $('#num'); // real (visually hidden) input: keyboard, paste and autofill all land here
// (425) 340-5583, built as you type
const fmt = (d) => (d.length < 4 ? (d ? `(${d}` : '') : d.length < 7 ? `(${d.slice(0, 3)}) ${d.slice(3)}` : `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`);
const render = () => {
  num.value = digits;
  typed.textContent = fmt(digits);
  typed.toggleAttribute('data-empty', !digits);
  sendBtn.disabled = digits.length !== 10;
};

const down = (el) => {
  el.classList.add('down');
  setTimeout(() => el.classList.remove('down'), 150);
};
function flash(k) {
  const btn = keypad.querySelector(`[data-k="${k}"]`);
  if (!btn) return;
  down(btn);
  if (!reduced) animate(btn, { scale: [0.9, 1], duration: 260, ease: 'outBack(2)' });
}
const shake = () => !reduced && animate('.field', { x: [0, -6, 6, -3, 0], duration: 300 });

// every change goes through here, whether it came from the pad, the keyboard or autofill
function setDigits(next) {
  if (busy) return render();
  let d = next.replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') d = d.slice(1); // pasted or autofilled +1
  if (/^[01]/.test(d)) {
    // US area codes never start with 0 or 1
    shake();
    d = d.replace(/^[01]+/, '');
  }
  d = d.slice(0, 10);
  if (d.length > digits.length) flash(d.at(-1));
  else if (d.length < digits.length) flash('del');
  digits = d;
  render();
}

keypad.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the input
keypad.addEventListener('click', (e) => {
  const k = e.target.closest('.key')?.dataset.k;
  if (!k) return;
  setDigits(k === 'del' ? digits.slice(0, -1) : digits + k);
  num.focus({ preventScroll: true });
});
compose.addEventListener('click', () => {
  openKeypad();
  num.focus({ preventScroll: true });
});
num.addEventListener('input', () => setDigits(num.value));
num.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    compose.requestSubmit();
  }
});
// a digit typed anywhere on the page jumps to the phone and starts the number
addEventListener('keydown', (e) => {
  if (e.target === num || e.metaKey || e.ctrlKey || e.altKey || !/^\d$/.test(e.key)) return;
  e.preventDefault();
  const end = $('#scroll');
  if (scrollY < end.offsetTop + end.offsetHeight * 0.6) scrollTo({ top: end.offsetTop + end.offsetHeight - innerHeight, behavior: reduced ? 'auto' : 'smooth' });
  openKeypad();
  num.focus({ preventScroll: true });
  setDigits(digits + e.key);
});

function openKeypad() {
  if (kbOn) return;
  kbOn = true;
  chatView.classList.add('kb');
  num.focus({ preventScroll: true }); // ready to type, no click needed
  keypad.style.height = 'auto';
  const h = keypad.offsetHeight;
  if (!reduced) {
    keypad.style.height = '0px';
    animate(keypad, { height: [0, h], duration: 480, ease: 'outQuart' });
  }
}
function closeKeypad() {
  kbOn = false;
  num.blur();
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
const root = document.documentElement;
const hint = $('#hint');
const hold = { t: 0 };

// background: 0 = black with a faint aura, 1 = the full living color field
const reveal = { v: reduced ? 1 : 0 };
const glowEl = $('#glow');
const hasGL = startGlow($('#bg'), reveal, reduced);
if (!hasGL) glowEl.classList.add('nogl');
const paintReveal = () => !hasGL && (glowEl.style.opacity = reveal.v);

if (reduced) {
  utils.set(['.off', '.lock', '.lede'], { opacity: 0 });
  utils.set('.statusbar', { color: '#000' });
  utils.set('.homebar', { opacity: 1 });
  root.style.setProperty('--bg', '#f5f6fb');
  root.style.setProperty('--fg', '#22272b');
  paintReveal();
  steps.filter((el) => el.hasAttribute('data-typing')).forEach((el) => el.remove());
  openKeypad();
  hint.classList.add('on');
} else {
  steps.forEach((el, i) => {
    el.style.transformOrigin = origin(el);
    utils.set(el, { opacity: 0, marginTop: hidden[i], scale: 0.6 });
  });
  utils.set('[data-notif]', { opacity: 0, y: -40, scale: 0.94 });
  utils.set(['.statusbar', '.touch'], { opacity: 0 });

  // The conversation follows the scroll, but its playhead can only chase the scroll position at
  // a capped speed and never goes backward: scroll fast and the texts still land one at a time.
  const chat = createTimeline({ autoplay: false });
  const at = [0, 1100, 1800, 2900, 3700, 4800, 5100, 5700, 6900, 7900];
  steps.forEach((el, i) => {
    chat.add(el, { opacity: [0, 1], marginTop: [hidden[i], shown[i]], scale: [0.6, 1], duration: 420, ease: 'outBack(1.4)' }, at[i]);
    if (el.hasAttribute('data-typing')) chat.add(el, { opacity: [1, 0], marginTop: [shown[i], hidden[i]], duration: 260, ease: 'outQuad' }, at[i + 1] - 140);
  });
  const CHAT_FROM = 450; // scroll-timeline time where the thread starts
  const CHAT_TO = 880; // ...and where it has fully played
  let target = 0;
  let head = 0;
  let scrollT = 0;
  let last = 0;
  const chase = (now) => {
    const dt = last ? Math.min(now - last, 50) : 16;
    last = now;
    if (head < target) {
      head = Math.min(target, head + dt * 3); // at most 3x real texting speed
      chat.seek(head);
      if (head >= chat.duration) openKeypad();
    }
    const on = kbOn && scrollT > CHAT_TO;
    if (on) {
      const r = compose.querySelector('.field').getBoundingClientRect();
      root.style.setProperty('--hint-y', `${r.top + r.height / 2}px`);
    }
    hint.classList.toggle('on', on);
    requestAnimationFrame(chase);
  };
  requestAnimationFrame(chase);

  createTimeline({
    defaults: { ease: 'outQuad', duration: 60 },
    autoplay: onScroll({ target: '#scroll', enter: 'top top', leave: 'bottom bottom', sync: 0.25 }),
    onUpdate: (self) => {
      paintReveal();
      const p = utils.clamp((self.currentTime - CHAT_FROM) / (CHAT_TO - CHAT_FROM), 0, 1);
      target = Math.max(target, p * chat.duration);
      scrollT = self.currentTime;
    },
  })
    // the phone turns over from its back and pulls away
    .add(phone, { rotateY: [200, 0], rotateX: [16, 0], rotateZ: [-8, 0], duration: 300, ease: 'inOutCubic' }, 0)
    .add(phone, { scale: [1.3, 0.82], y: [420, 100], duration: 300, ease: 'inOutCubic' }, 0)
    .add('.lede', { opacity: [1, 0], y: [0, -40], duration: 50 }, 230)
    .add('.screen', { '--sheen': ['-60%', '60%'], duration: 520, ease: 'linear' }, 0)
    // wake, notify, swipe up to unlock
    .add('.off', { opacity: [1, 0], duration: 50 }, 270)
    .add('.statusbar', { opacity: [0, 1], duration: 40 }, 270)
    .add('[data-notif]', { opacity: [0, 1], y: [-40, 0], scale: [0.94, 1], duration: 70, ease: 'outBack' }, 320)
    .add('.swipe-text', { opacity: [0.85, 0.35, 0.85], duration: 60, ease: 'inOutSine' }, 380)
    .add('.touch', { opacity: [0, 1], scale: [1.3, 1], duration: 25 }, 410)
    .add('.touch', { y: [-40, -520], opacity: [1, 0], duration: 70, ease: 'inQuad' }, 440)
    .add('.lock', { y: ['0%', '-100%'], duration: 70, ease: 'inOutQuad' }, 440)
    .add('.statusbar', { color: ['#fff', '#000'], duration: 20 }, 485)
    .add('.homebar', { opacity: [0, 1], duration: 20 }, 490)
    // color grows out of the black behind the phone; the page settles to light under it
    .add(reveal, { v: [0, 1], duration: 170, ease: 'inOutSine' }, 445)
    .add(root, { '--bg': ['#000000', '#f5f6fb'], '--fg': ['#f5f6fb', '#22272b'], duration: 20, ease: 'linear' }, 590)
    .add(phone, { scale: [0.82, 1], y: [100, 0], duration: 90, ease: 'inOutQuad' }, 520)
    // hold the finished phone before the footer
    .add(hold, { t: [0, 1], duration: 120, ease: 'linear' }, 880);
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
      ? 'just texted you. reply there and we\'ll get started'
      : res.status === 429
        ? "that's a lot of tries. give it a few minutes"
        : res.status === 400
          ? "hm, that number didn't work. try it again?"
          : "something broke on my end. try again in a minute";
  } catch {
    reply = "I can't reach my phone right now. try again in a minute";
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
