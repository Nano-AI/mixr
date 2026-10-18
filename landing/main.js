import { animate, createTimeline, stagger, utils } from 'https://cdn.jsdelivr.net/npm/animejs@4.5.0/dist/bundles/anime.esm.min.js';
import { startGlow } from './glow.js';

// sign-up server: api.joinmixr.club on joinmixr.club, a local one anywhere else.
// Overrides for testing: window.MIXR_API (set before this script), or ?api=https://… on any host but
// joinmixr.club (there, a shared link could send people's numbers elsewhere).
// ?mock=ok|full|error|offline skips the network and answers with a canned response.
const query = new URLSearchParams(location.search);
const PROD = /(^|\.)joinmixr\.club$/.test(location.hostname);
const API = (window.MIXR_API || (!PROD && query.get('api')) || (PROD ? 'https://api.joinmixr.club' : 'http://localhost:8787')).replace(/\/+$/, '');
const MOCK = query.get('mock');
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
let joined = false; // number sent: the conversation is over, the field stays shut
const num = $('#num'); // real (visually hidden) input: keyboard, paste and autofill all land here
// touch screens type on the drawn pad; focusing the hidden input there makes iOS Safari scroll it
// into view (preventScroll or not), which shifts the whole fixed page
const touch = matchMedia('(pointer: coarse)').matches;
const focusNum = () => !touch && num.focus({ preventScroll: true });
// (425) 340-5583, built as you type
const fmt = (d) => (d.length < 4 ? (d ? `(${d}` : '') : d.length < 7 ? `(${d.slice(0, 3)}) ${d.slice(3)}` : `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`);
const render = () => {
  num.value = digits;
  typed.textContent = fmt(digits);
  typed.toggleAttribute('data-empty', !digits);
  sendBtn.disabled = digits.length !== 10;
  compose.classList.toggle('ready', kbOn && !digits && !busy && !joined); // pulse the field: type here
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
  if (busy || joined) return render();
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
  focusNum();
});
compose.addEventListener('click', () => {
  openKeypad();
  focusNum();
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
  if (joined || e.target === num || e.metaKey || e.ctrlKey || e.altKey || !/^\d$/.test(e.key)) return;
  e.preventDefault();
  go(Infinity);
  openKeypad();
  focusNum();
  setDigits(digits + e.key);
});

function openKeypad() {
  if (kbOn || joined) return;
  kbOn = true;
  chatView.classList.add('kb');
  render();
  focusNum(); // ready to type, no click needed
  keypad.style.height = 'auto';
  const h = keypad.offsetHeight;
  if (!reduced) {
    keypad.style.height = '0px';
    animate(keypad, { height: [0, h], duration: 480, ease: 'outQuart' });
  }
}
function closeKeypad() {
  kbOn = false;
  render();
  num.blur();
  const done = () => chatView.classList.remove('kb');
  if (reduced) return (keypad.style.height = '0px'), done();
  animate(keypad, { height: 0, duration: 380, ease: 'inOutQuad', onComplete: done });
}

// ── the story ──
let go = () => {}; // move to a slide; set up below unless motion is reduced
let zoomOut = () => {}; // after joining: back to the whole phone
const steps = [...rail.querySelectorAll('[data-step]')];
// hidden steps collapse via negative margin so the thread grows from the bottom like iOS
const shown = steps.map((el) => parseFloat(getComputedStyle(el).marginTop));
const hidden = steps.map((el) => -el.offsetHeight);
const origin = (el) => (el.classList.contains('me') || el.classList.contains('receipt') ? '100% 100%' : '0% 100%');
const root = document.documentElement;
const hint = $('#hint');
const stage = $('.stage');

// background: 0 = black with a faint aura, 1 = the full living color field
const reveal = { v: reduced ? 1 : 0, goal: reduced ? 1 : 0 };
const glowEl = $('#glow');
const hasGL = startGlow($('#bg'), reveal, reduced);
if (!hasGL) glowEl.classList.add('nogl');
const paintReveal = () => !hasGL && (glowEl.style.opacity = reveal.v);
// 0 = black page with light ink, 1 = light page with dark ink. Mixed here rather than with CSS
// color-mix(), which older Safari can't parse with a calc() amount
const mix = (a, b, t) => `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * t))})`;
const paintLit = (t) => {
  root.style.setProperty('--bg', mix([0, 0, 0], [245, 246, 251], t));
  root.style.setProperty('--fg', mix([245, 246, 251], [34, 39, 43], t));
};

if (reduced) {
  utils.set(['.off', '.lock', '.hero', '.origin'], { opacity: 0 });
  utils.set('.statusbar', { color: '#000' });
  utils.set('.homebar', { opacity: 1 });
  paintLit(1);
  paintReveal();
  steps.filter((el) => el.hasAttribute('data-typing')).forEach((el) => el.remove());
  openKeypad();
  root.classList.add('end');
} else {
  steps.forEach((el, i) => {
    el.style.transformOrigin = origin(el);
    utils.set(el, { opacity: 0, marginTop: hidden[i], scale: 0.6 });
  });
  utils.set('[data-notif]', { opacity: 0, y: -40, scale: 0.94 });
  utils.set(['.statusbar', '.touch'], { opacity: 0 });

  // the conversation as one timeline; slides set how far it plays (see SLIDES)
  const chat = createTimeline({ autoplay: false });
  const at = [0, 1100, 1350, 1800, 2900, 3700, 4800, 5100, 5700, 6900, 7500, 8500];
  steps.forEach((el, i) => {
    chat.add(el, { opacity: [0, 1], marginTop: [hidden[i], shown[i]], scale: [0.6, 1], duration: 420, ease: 'outBack(1.4)' }, at[i]);
    // receipts work like iOS: Delivered flips to Read as mixr starts typing, and only the latest
    // sent message keeps one, so each receipt folds away when the next message goes out
    if (el.classList.contains('receipt')) {
      chat.add(el.children[0], { opacity: [1, 0], duration: 200 }, at[i + 1] - 100).add(el.children[1], { opacity: [0, 1], duration: 200 }, at[i + 1] - 100);
      const next = steps.findIndex((s, j) => j > i && s.classList.contains('me'));
      if (next > -1) chat.add(el, { opacity: [1, 0], marginTop: [shown[i], hidden[i]], duration: 260, ease: 'outQuad' }, at[next]);
    }
    if (el.hasAttribute('data-typing')) chat.add(el, { opacity: [1, 0], marginTop: [shown[i], hidden[i]], duration: 260, ease: 'outQuad' }, at[i + 1] - 140);
  });
  // ── slides: one screen, no page scroll. Each slide is a point on the story timeline (0..1000) plus
  // how far the conversation has played; moving between slides plays the animation in between.
  const chatEnd = (i) => at[i] + 420; // chat time when step i has fully landed
  const SLIDES = [
    { t: 0, chat: 0 }, // hero, phone on its back
    { t: 400, chat: 0 }, // lock screen with mixr's notification
    { t: 700, chat: chatEnd(0) }, // Messages opens on mixr's first text
    { t: 700, chat: chatEnd(5) }, // you answer; mixr finds people and a time
    { t: 700, chat: chatEnd(11) }, // you're in; your turn
    { t: 1000, chat: chatEnd(11) }, // zoomed on the number pad
  ];
  const LAST = SLIDES.length - 1;
  let slide = -1;
  let move; // the running slide transition
  const pos = { t: 0 };
  let head = 0;
  let last = 0;
  let speed = 1.5; // chat playback, x real time

  const dots = $('#dots');
  SLIDES.forEach((_, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('aria-label', `Step ${i + 1} of ${SLIDES.length}`);
    b.addEventListener('click', () => go(i));
    dots.append(b);
  });

  zoomOut = () => {
    SLIDES[LAST].t = 700; // the pad is done: the last slide is now the whole phone
    root.classList.remove('end');
    go(LAST);
  };

  $('#more').addEventListener('click', () => go(slide + 1));

  go = (i) => {
    i = utils.clamp(i, 0, LAST);
    if (i > 0) root.classList.add('moved'); // the swipe cue has done its job
    if (i === slide && !move && pos.t === SLIDES[i].t) return;
    speed = Math.abs(i - slide) > 1 ? 6 : 1.5; // a jump (nav button, a dot) fast-forwards the texts
    slide = i;
    [...dots.children].forEach((d, j) => d.toggleAttribute('aria-current', j === i));
    root.classList.toggle('end', i === LAST && !joined);
    if (i === LAST) openKeypad();
    else if (kbOn && !joined) closeKeypad();
    move?.pause();
    const d = Math.abs(SLIDES[i].t - pos.t);
    move = animate(pos, {
      t: SLIDES[i].t,
      duration: utils.clamp(d * 2.6, d ? 600 : 0, 1500),
      ease: 'inOutSine',
      onUpdate: () => story.seek(pos.t),
      onComplete: () => (move = null),
    });
  };

  const chase = (now) => {
    const dt = last ? Math.min(now - last, 50) : 16;
    last = now;
    // color on past the unlock, off only once clearly back before it
    if (pos.t > 470) reveal.goal = 1;
    else if (pos.t < 420) reveal.goal = 0;
    // texts land one at a time once the phone has settled; going back plays them out in reverse,
    // quickly, rather than cutting (a cut reads as a glitch)
    const target = pos.t >= 690 ? SLIDES[slide].chat : 0;
    if (head > target) chat.seek((head = Math.max(target, head - dt * 8)));
    else if (head < target) chat.seek((head = Math.min(target, head + dt * speed)));
    // the page turns light as the color reaches the top edge behind the nav (cover ~0.12..0.5; the
    // corners fill last), on the same clock, so nav and background change together
    const x = hasGL ? utils.clamp((reveal.cover - 0.12) / 0.38, 0, 1) : reveal.v;
    paintLit(x * x * (3 - 2 * x));
    const on = kbOn && slide === LAST && !move && innerWidth >= 1000;
    if (on) {
      const f = compose.querySelector('.field').getBoundingClientRect();
      root.style.setProperty('--hint-y', `${f.top + f.height / 2}px`);
      root.style.setProperty('--hint-x', `${phone.getBoundingClientRect().left}px`);
    }
    hint.classList.toggle('on', on);
    requestAnimationFrame(chase);
  };
  requestAnimationFrame(chase);

  // last slide: zoom to the bottom of the phone so the pad is as big as the screen allows, ending
  // above the consent note (measured: it wraps to 4-5 lines on a phone). y is in phone units (scaled
  // by --s), the zoom by z.
  const zoom = () => {
    const s = parseFloat(phone.style.getPropertyValue('--s'));
    const room = innerHeight - $('.foot').getBoundingClientRect().top + 12; // viewport bottom to the phone's
    const z = Math.min((innerWidth * 0.96) / (426 * s), (innerHeight - room - 76) / (520 * s), 1.45);
    return { z, y: (innerHeight / 2 - room) / s - 449 * z };
  };

  const story = createTimeline({ defaults: { ease: 'outQuad', duration: 60 }, autoplay: false, onUpdate: paintReveal })
    // the phone turns over from its back and pulls away
    .add(phone, { rotateY: [200, 0], rotateX: [16, 0], rotateZ: [-8, 0], duration: 300, ease: 'inOutCubic' }, 0)
    .add(phone, { scale: [1.3, 0.82], y: [480, 100], duration: 300, ease: 'inOutCubic' }, 0)
    // the rising phone pushes the hero up and out under the clip edge below the nav
    .add('.hero', { y: [0, () => -$('.hero').getBoundingClientRect().bottom], duration: 260, ease: 'inOutCubic' }, 0)
    .add('.origin', { opacity: [1, 0], duration: 120 }, 0)
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
    .add(phone, { scale: [0.82, 1], y: [100, 0], duration: 90, ease: 'inOutQuad' }, 520)
    .add(phone, { scale: [1, () => zoom().z], y: [0, () => zoom().y], duration: 300, ease: 'inOutSine' }, 700)
    // keeps the timeline exactly 1000 long, so slide times are story times
    .add({ t: 0 }, { t: 1, duration: 1 }, 999);

  // input: one wheel gesture, swipe, tap or arrow key moves one slide
  const busyTarget = (t) => t.closest('a, button, .compose, .keypad');
  // A trackpad flick keeps firing a decaying momentum tail for a second or two with no gap in it, so a
  // pause alone can't end a gesture: a new one also starts when the direction flips, or when the
  // deltas climb again after fading (a fresh flick cutting the momentum off). A mouse wheel's steady
  // notches never fade, so a fast spin still moves one slide.
  let quietSince = 0;
  let armed = true;
  let dir = 0;
  let avg = 0; // |delta| smoothed, so jitter in a slow drag doesn't read as a new flick
  let peak = 0; // biggest avg so far in this gesture
  let low = 0; // smallest avg since that peak
  addEventListener('wheel', (e) => {
    e.preventDefault();
    const now = performance.now();
    const d = Math.abs(e.deltaY);
    const s = Math.sign(e.deltaY);
    if (!s) return (quietSince = now); // sideways only
    const fresh = now - quietSince > 220 || s !== dir;
    avg = fresh ? d : avg + (d - avg) / 3;
    if (fresh || (low < peak / 2 && avg > low * 2)) {
      armed = true;
      peak = 0;
    }
    quietSince = now;
    dir = s;
    if (avg >= peak) peak = low = avg;
    else low = Math.min(low, avg);
    if (armed && d > 6) {
      armed = false;
      go(slide + s);
    }
  }, { passive: false });
  let touchY = null;
  addEventListener('touchstart', (e) => (touchY = e.touches[0].clientY), { passive: true });
  addEventListener('touchmove', (e) => e.cancelable && e.preventDefault(), { passive: false });
  addEventListener('touchend', (e) => {
    if (touchY === null) return;
    const dy = touchY - e.changedTouches[0].clientY;
    touchY = null;
    if (Math.abs(dy) > 40) go(slide + Math.sign(dy));
    else if (Math.abs(dy) < 8 && !busyTarget(e.target) && slide < LAST) go(slide + 1);
  });
  let pointer = '';
  addEventListener('pointerdown', (e) => (pointer = e.pointerType));
  addEventListener('click', (e) => {
    // mouse clicks advance too; touch taps are handled above
    if (pointer === 'mouse' && !busyTarget(e.target) && slide < LAST) go(slide + 1);
  });
  addEventListener('keydown', (e) => {
    if (e.target === num) return;
    if (['ArrowDown', 'PageDown', ' '].includes(e.key)) go(slide + 1);
    else if (['ArrowUp', 'PageUp'].includes(e.key)) go(slide - 1);
    else return;
    e.preventDefault();
  });
  go(0);
}

// the one load-in moment: the hero settles into place
if (!reduced) animate('.hero > *', { opacity: [0, 1], y: [24, 0], duration: 1100, delay: stagger(120, { start: 150 }), ease: 'outExpo' });

$('#toJoin').addEventListener('click', (e) => {
  e.preventDefault();
  go(Infinity);
});

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

const sleep = (ms) => new Promise((r) => setTimeout(r, reduced ? 0 : ms));
const typing = () => {
  const dots = bubble('typing them', '');
  dots.innerHTML = '<i></i><i></i><i></i>';
  return dots;
};
const say = async (content, cls = 'b them') => {
  const dots = typing();
  await sleep(900);
  dots.remove();
  return bubble(cls, content);
};

// POST {phone} → 200 {ok, number, link} | 409 {full} | 400/429/5xx {error}. mixr never texts first:
// joining hands you your own mixr number, and `link` opens Messages to it with "hi mixr" typed
const MOCKS = {
  ok: [200, { ok: true, number: '+16285551234', link: 'sms:+16285551234&body=hi%20mixr' }],
  full: [409, { ok: false, full: true, error: 'mixr is full.' }],
  error: [502, { ok: false, error: "couldn't set up your line. try again in a minute" }],
};
async function join(phone) {
  if (MOCK) {
    await sleep(700);
    if (!MOCKS[MOCK]) throw new TypeError('mock: offline'); // ?mock=offline, or any other value
    const [status, data] = MOCKS[MOCK];
    return { ok: status === 200, status, data };
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000); // never leave them watching the typing dots
  try {
    const res = await fetch(`${API}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone }),
      signal: ctl.signal,
    });
    return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
  } finally {
    clearTimeout(timer);
  }
}

// your mixr line: the number big and selectable (on a laptop you'll text it from your phone), and a
// real link that opens Messages to it
function lineCard(number, link) {
  const d = String(number).replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  const pretty = d.length === 10 ? fmt(d) : String(number);
  // only hand the link to the browser if it's a web or sms link; anything else gets a plain sms: one
  let href = `sms:${number}&body=hi%20mixr`;
  try {
    if (['https:', 'sms:'].includes(new URL(link).protocol)) href = link;
  } catch {}
  const el = (tag, cls, text) => Object.assign(document.createElement(tag), { className: cls, textContent: text });
  const a = el('a', 'line-cta', 'text mixr');
  a.href = href;
  a.setAttribute('aria-label', `text mixr at ${pretty} in Messages`);
  if (!touch) Object.assign(a, { target: '_blank', rel: 'noopener' }); // keep this page, and the number, open
  const card = document.createDocumentFragment();
  card.append(
    el('span', 'line-num', pretty),
    a,
    el('span', 'line-note', touch ? "save this number — it's your mixr line" : "save this number — it's your mixr line. text it from your phone"),
  );
  return card;
}

compose.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (digits.length !== 10 || busy) return;
  busy = true;
  const number = digits;
  rail.querySelectorAll('.receipt').forEach((r) => r.remove());
  bubble('b me', fmt(number));
  digits = '';
  render();

  // mixr "types" while the request runs, for at least a beat
  const dots = typing();
  const [r] = await Promise.allSettled([join(`+1${number}`), sleep(900)]);
  dots.remove();
  const res = r.status === 'fulfilled' ? r.value : null; // null: offline, blocked or timed out
  const ok = res?.ok && res.data?.ok && res.data.number;
  if (ok) {
    joined = true;
    num.disabled = true;
    compose.classList.add('done');
    zoomOut();
    const rc = bubble('receipt', 'Delivered');
    setTimeout(() => (rc.textContent = `Read ${$('[data-clock]').textContent}`), reduced ? 0 : 500);
    closeKeypad();
    bubble('b them', "you're in! text mixr to get started:");
    const card = await say(lineCard(res.data.number, res.data.link), 'b them line');
    if (!touch) card.querySelector('a').focus({ preventScroll: true }); // Enter opens Messages
    busy = false;
    return;
  }
  const said = typeof res?.data?.error === 'string' && res.data.error; // the server's own words
  bubble(
    'b them',
    !res
      ? "I can't reach my phone right now. try again in a minute"
      : res.status === 409 || res.data?.full
        ? "mixr's at capacity right now — we'll open more spots soon"
        : said ||
          (res.status === 429
            ? "that's a lot of tries. give it a few minutes"
            : res.status === 400
              ? "hm, that number didn't work. try it again?"
              : 'something broke on my end. try again in a minute'),
  );
  // put the number back so trying again is one tap on send
  digits = number;
  render();
  focusNum();
  if (SMS) {
    const a = document.createElement('a');
    a.href = `sms:${SMS}&body=hi`;
    a.textContent = 'Or text me hi directly.';
    await say(a);
  }
  busy = false;
});

render();
