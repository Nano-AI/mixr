import { animate, createTimeline, onScroll, utils } from 'https://cdn.jsdelivr.net/npm/animejs@4.5.0/dist/bundles/anime.esm.min.js';

const API = location.hostname.endsWith('joinmixr.club') ? 'https://api.joinmixr.club' : 'http://localhost:3000';
const SMS = document.body.dataset.sms; // set data-sms="+1..." on <body> to offer a text-us fallback

const $ = (s) => document.querySelector(s);
const phone = $('#phone');
const rail = $('#rail');
const compose = $('#compose');
const input = $('#phoneInput');
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
const fit = () => phone.style.setProperty('--s', Math.min(0.8, (innerWidth * 0.8) / 426, (innerHeight * 0.76) / 898));
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

// ── scroll story ──
const steps = [...rail.querySelectorAll('[data-step]')];
// hidden steps collapse via negative margin so the thread grows from the bottom like iOS
const shown = steps.map((el) => parseFloat(getComputedStyle(el).marginTop));
const hidden = steps.map((el) => -el.offsetHeight);
const pop = (el) => ({ transformOrigin: el.classList.contains('me') || el.classList.contains('receipt') ? '100% 100%' : '0% 100%' });

const ready = () => {
  compose.classList.add('ready');
};

if (reduced) {
  utils.set(['.off', '.lock'], { opacity: 0 });
  utils.set('.statusbar', { color: '#000' });
  utils.set(['.homebar', '#hint'], { opacity: 1 });
  utils.set('.lede', { opacity: 0 });
  steps.filter((el) => el.hasAttribute('data-typing')).forEach((el) => el.remove());
  ready();
} else {
  steps.forEach((el, i) => utils.set(el, { opacity: 0, marginTop: hidden[i], scale: 0.6, ...pop(el) }));
  utils.set('[data-notif]', { opacity: 0, y: -40, scale: 0.94 });
  utils.set('.statusbar', { opacity: 0 });

  const tl = createTimeline({
    defaults: { ease: 'outQuad', duration: 60 },
    autoplay: onScroll({ target: '#scroll', enter: 'top top', leave: 'bottom bottom', sync: 0.25 }),
    onUpdate: (self) => compose.classList.toggle('ready', self.progress > 0.97),
  })
    // pick the phone up off the table
    .add(phone, { rotateX: [62, 0], rotateZ: [-24, 0], rotateY: [14, 0], y: [300, 0], duration: 320, ease: 'inOutCubic' }, 0)
    .add('.lede', { opacity: [1, 0], y: [0, -50], duration: 180 }, 0)
    .add('.screen', { '--sheen': ['-60%', '60%'], duration: 520, ease: 'linear' }, 0)
    // wake, notify, open
    .add('.off', { opacity: [1, 0], duration: 50 }, 280)
    .add('.statusbar', { opacity: [0, 1], duration: 40 }, 280)
    .add('[data-notif]', { opacity: [0, 1], y: [-40, 0], scale: [0.94, 1], duration: 70, ease: 'outBack' }, 340)
    .add('[data-notif]', { scale: [1, 1.06], opacity: [1, 0], duration: 50 }, 450)
    .add('.lock', { opacity: [1, 0], scale: [1, 1.08], duration: 60 }, 455)
    .add('.statusbar', { color: ['#fff', '#000'], duration: 30 }, 470)
    .add('.homebar', { opacity: [0, 1], duration: 30 }, 470);

  // the conversation, one bubble at a time
  const at = [480, 560, 610, 660, 700, 760, 785, 830, 870, 920];
  steps.forEach((el, i) => {
    tl.add(el, { opacity: [0, 1], marginTop: [hidden[i], shown[i]], scale: [0.6, 1], duration: 40, ease: 'outBack(1.4)' }, at[i]);
    if (el.hasAttribute('data-typing')) tl.add(el, { opacity: [1, 0], marginTop: [shown[i], hidden[i]], duration: 30 }, at[i + 1] - 5);
  });
  tl.add('#hint', { opacity: [0, 1], y: [10, 0], duration: 40 }, 950);
}

// ── the real sign-up: type into the phone ──
function bubble(cls, text) {
  const p = document.createElement('p');
  p.className = cls;
  if (text instanceof Node) p.append(text);
  else p.textContent = text;
  p.style.transformOrigin = pop(p).transformOrigin;
  rail.append(p);
  if (!reduced) animate(p, { opacity: [0, 1], scale: [0.6, 1], duration: 380, ease: 'outBack(1.4)' });
  return p;
}

const say = async (text) => {
  const dots = bubble('typing them', '');
  dots.innerHTML = '<i></i><i></i><i></i>';
  await new Promise((r) => setTimeout(r, reduced ? 0 : 900));
  dots.remove();
  return bubble('b them', text);
};

let busy = false;
compose.addEventListener('submit', async (e) => {
  e.preventDefault();
  const raw = input.value.trim();
  if (!raw || busy) return;
  busy = true;
  input.value = '';
  rail.querySelectorAll('.receipt').forEach((r) => r.remove());
  bubble('b me', raw);

  const digits = raw.replace(/\D/g, '');
  if (!(digits.length === 10 || (digits.length === 11 && digits[0] === '1'))) {
    await say("I'll need your number to text you. Just the 10 digits works.");
    busy = false;
    input.focus();
    return;
  }

  let reply;
  try {
    const res = await fetch(`${API}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: raw }),
    });
    if (res.ok) {
      bubble('receipt', 'Delivered');
      reply = 'Just texted you. Reply YES there to get started.';
    } else {
      reply = (await res.json().catch(() => ({}))).error ?? "That didn't go through. Try again in a minute.";
    }
  } catch {
    reply = "I can't reach my phone right now. Try again in a minute.";
  }
  if (SMS && !reply.startsWith('Just')) {
    const a = document.createElement('a');
    a.href = `sms:${SMS}&body=hi`;
    a.textContent = 'Or text me hi directly.';
    await say(reply);
    await say(a);
  } else {
    await say(reply);
  }
  busy = false;
});
