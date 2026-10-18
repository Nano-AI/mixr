import { randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';
import { one, q } from '../db/index.ts';
import { MINUTE, now } from '../clock.ts';
import type { OnboardingStep, User } from '../types.ts';
import { firstName } from '../events/copy.ts';
import { createEmailSender, type CodeSender } from './email.ts';
import { cardLine, send } from '../transport/index.ts';
import { queueDelivery } from '../transport/outbox.ts';
import { config } from '../config.ts';

// Real users before the agent takes over, deterministic (no LLM): consent -> full name -> email -> verify.
// On success: email_verified = true, step = NULL, state stays 'onboarding', and the agent handles the braindump.
// Each call answers one inbound text with exactly one reply (the caller sends it).

const CODE_TTL_MS = 10 * MINUTE; // tune: how long an emailed code stays valid
const RESEND_WAIT_MS = 1 * MINUTE; // tune: minimum gap between codes for one person
const MAX_CODE_ATTEMPTS = 3; // tune: wrong codes before a new one is needed
const NAME_MAX = 80;
const NAME_WORDS = 4; // tune:
const EMAIL_MAX = 254;

export const CONSENT =
  "hey! i'm mixr. i find UW students with shared interests and help organize meetups. Reply YES to opt in. Message frequency varies. Reply STOP anytime.";
// WELCOME_TEXT=on: mixr's first text after a website join, sent before they've texted. It doubles as the consent
// disclosure, so their YES opts them in and a reply that isn't YES gets the ask again, not a second hello.
// Text-only (no link): Photon's deliverability guide says links in a first message hurt.
export const WELCOME =
  "hey, it's mixr! you just signed up on the mixr site. i find UW students with shared interests and help organize meetups. reply YES to opt in. reply STOP to opt out";
const CONSENT_AGAIN = "reply YES to opt in and i'll get you set up. reply STOP anytime.";
const CONSENT_WORDS = ['YES', 'Y', 'I AGREE', 'OPT IN'];
const ASK_NAME = "what's your full name? (first and last)";
const NAME_AGAIN = `what's your full name? (first and last, just letters, up to ${NAME_MAX} characters)`;
// One word so far: nothing is saved; the first name rides along in this reply (our own text) until the last name comes.
const askLast = (first: string): string => `got it, ${first}! and your last name?`;
const LAST_AGAIN = ' (just your last name, letters only)';
const ASKED_LAST = /^got it, ([^\s,!?]+)! and your last name\?/;
const ASK_EMAIL = "what's your @uw.edu email? i use it to keep mixr UW-only.";
const ASK_CODE = "reply with the 6-digit code from your UW inbox. can't find it? check spam or junk. or text EMAIL to use a different address.";
const EMAIL_TAKEN = "that email is already connected to another mixr account. if that's not right, reach out to the mixr team.";
export const CODE_PLACEHOLDER = '[verification code]';

// The first thing the agent's onboarding builds on: the user has a name, now they braindump. Greets by first name.
export const braindumpPrompt = (name: string | null): string =>
  `you're verified${name ? `, ${firstName(name)}` : ''}! now the fun part: braindump me what you're into. sports, games, music, hobbies, stuff you wanna try, and how serious you are about each. the more you tell me, the better your matches.`;

// What to say when someone comes back mid-onboarding (START after STOP).
export function stepPrompt(step: OnboardingStep): string {
  if (step === 'name') return ASK_NAME;
  if (step === 'email') return ASK_EMAIL;
  if (step === 'verify') return ASK_CODE;
  return CONSENT;
}

// Who emails the codes. Tests inject a capturing sender; otherwise built from the environment on first use.
let codeSender: CodeSender | null = null;
export const setCodeSender = (fn: CodeSender | null): void => void (codeSender = fn);
const sender = (): CodeSender => (codeSender ??= createEmailSender());

// "stop." / " Yes! " -> "STOP" / "YES". Used for every keyword comparison.
export const keyword = (text: string): string =>
  text
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/^["'\s.!?]+|["'\s.!?]+$/g, '')
    .toUpperCase();

export async function onboard(user: User, text: string): Promise<string> {
  const said = text.trim();
  const word = keyword(said);
  const t = await now();
  switch (user.step) {
    case 'name':
      return takeName(user, said);
    case 'email':
      return requestCode(user, said, t);
    case 'verify':
      return verify(user, said, word, t);
    case 'consent':
    default:
      return takeConsent(user, word, t);
  }
}

async function takeConsent(user: User, word: string, t: Date): Promise<string> {
  // A YES only counts once they've seen what they're agreeing to (a first text of "yes" gets the disclosure): the
  // consent text, or the welcome unless its delivery is known to have not gone through.
  const seen = await q<{ text: string }>(
    `SELECT DISTINCT m.text FROM messages m LEFT JOIN message_jobs j ON j.message_id = m.id
     WHERE m.user_id = $1 AND m.direction = 'out' AND (m.text = $2 OR (m.text = $3 AND (j.id IS NULL OR j.status = 'sent')))`,
    [user.id, CONSENT, WELCOME],
  );
  if (!seen.length || !CONSENT_WORDS.includes(word)) {
    if (user.step !== 'consent') await setStep(user.id, 'consent');
    return seen.some((r) => r.text === WELCOME) ? CONSENT_AGAIN : CONSENT;
  }
  await q(`UPDATE users SET consent_at = $2, step = 'name' WHERE id = $1`, [user.id, t.toISOString()]);
  return `you're in! ${ASK_NAME}`;
}

// Whole replies that aren't names: a repeated YES, or a brush-off when asked for a last name.
const NOT_NAMES = [...CONSENT_WORDS, 'NO', 'NOPE', 'NAH', 'IDK', 'NONE', 'SKIP', 'WHY'];
// Lowercase mid-name ("maria de la cruz" -> "Maria de la Cruz").
const PARTICLES = new Set(['de', 'da', 'di', 'do', 'dos', 'das', 'du', 'del', 'della', 'der', 'den', 'la', 'le', 'van', 'von']);

// Names show up in the agent's context and (first name only) in other people's texts, so only letters,
// spaces, apostrophes, hyphens and periods, a few words at most, every word with a letter in it.
function validName(name: string): boolean {
  const words = name.split(' ');
  return (
    name.length <= NAME_MAX &&
    words.length <= NAME_WORDS &&
    /^[\p{L}\p{M}'’. -]+$/u.test(name) &&
    words.every((w) => /\p{L}/u.test(w)) &&
    !NOT_NAMES.includes(name.toUpperCase())
  );
}

// "riley o'connor" -> "Riley O'Connor". Only all-lowercase input is touched, so "McDonald" or "de la Cruz" typed with
// capitals stays as typed. `before` = name words already in front of this piece (a last name added to a first name).
function capitalize(name: string, before = 0): string {
  if (name !== name.toLowerCase()) return name;
  const words = name.split(' ');
  return words
    .map((w, i) =>
      i + before > 0 && i < words.length - 1 && PARTICLES.has(w)
        ? w
        : w
            .replace(/(^|[-.])(\p{L})/gu, (_, p: string, c: string) => p + c.toUpperCase()) // smith-jones, j.r.
            .replace(/(^|-)(\p{L}['’])(\p{L})/gu, (_, p: string, o: string, c: string) => p + o + c.toUpperCase()) // o'connor
            .replace(/^Mc(\p{L})/u, (_, c: string) => `Mc${c.toUpperCase()}`),
    )
    .join(' ');
}

// "hey, i'm ana lee!" -> "Ana Lee". 1 to NAME_WORDS words (the caller decides whether a single word is enough).
export function cleanName(said: string, before = 0): string | null {
  const name = said
    .replace(/^(hi|hey|hello|yo)\b[\s,!.]*/i, '')
    .replace(/^(?:i['’]?m|i am|it['’]?s|this is|call me|(?:my )?(?:full |first |last |sur)?name(?:['’]?s| is))\s+/i, '')
    .replace(/[\s.!?,]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return validName(name) ? capitalize(name, before) : null;
}

// "it's Ana@UW.edu." -> "ana@uw.edu" (validated by the caller).
export const extractEmail = (said: string): string =>
  (said.toLowerCase().match(/[^\s<>()"',;:]+@[^\s<>()"',;:]+/)?.[0] ?? '').replace(/[.!?]+$/, '');

// Full name (first and last). A single word is taken as the first name: nothing is saved, the reply asks for the
// last name, and the next text completes it (or repeats the whole name, "ana lee").
async function takeName(user: User, said: string): Promise<string> {
  const first = await askedLastFor(user.id);
  if (first) {
    const last = cleanName(said, 1);
    if (!last) return askLast(first) + LAST_AGAIN;
    const whole = last.includes(' ') && last.split(' ')[0].toLowerCase() === first.toLowerCase();
    const name = whole ? cleanName(said) : `${first} ${last}`;
    if (!name || !validName(name)) return NAME_AGAIN;
    return saveName(user, name);
  }
  const name = cleanName(said);
  if (!name) return NAME_AGAIN;
  if (!name.includes(' ')) return askLast(name);
  return saveName(user, name);
}

// The first name waiting on a last name: only right after mixr asked for it (the inbound is already recorded).
async function askedLastFor(userId: number): Promise<string | null> {
  const out = await one<{ text: string }>(`SELECT text FROM messages WHERE user_id = $1 AND direction = 'out' ORDER BY id DESC LIMIT 1`, [userId]);
  return out?.text.match(ASKED_LAST)?.[1] ?? null;
}

async function saveName(user: User, name: string): Promise<string> {
  await q(`UPDATE users SET name = $2, step = 'email' WHERE id = $1`, [user.id, name]);
  return `nice to meet you, ${firstName(name)}! ${ASK_EMAIL}`;
}

// A verified email belongs to one phone. Checked when a code is requested and again (atomically) on success.
async function emailTaken(email: string, userId: number): Promise<boolean> {
  return !!(await one(`SELECT 1 FROM users WHERE email = $1 AND email_verified AND id <> $2`, [email, userId]));
}

const hashCode = (code: string, salt: string): Promise<Buffer> =>
  new Promise((resolve, reject) => scrypt(code, salt, 32, (e, key) => (e ? reject(e) : resolve(key))));

async function requestCode(user: User, said: string, t: Date): Promise<string> {
  const email = extractEmail(said);
  if (email.length > EMAIL_MAX || !/^[^\s@]+@uw\.edu$/.test(email)) return "that needs to be a @uw.edu address. what's your UW email?";
  if (await emailTaken(email, user.id)) return EMAIL_TAKEN;
  // The wait survives wrong codes and expiry (the row is kept until success), so codes can't be farmed.
  const last = await one<{ sent_at: string }>(`SELECT sent_at FROM email_codes WHERE user_id = $1`, [user.id]);
  if (last && t.getTime() - new Date(last.sent_at).getTime() < RESEND_WAIT_MS) return 'give it a minute before i send another code, then send your @uw.edu address again.';

  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const salt = randomBytes(16).toString('hex');
  const hash = (await hashCode(code, salt)).toString('hex');
  try {
    await sender()(email, code);
  } catch (e) {
    // Fail closed. Never log the code (or the address).
    const why = (e instanceof Error ? e.message : String(e)).replaceAll(code, '[code]').slice(0, 200);
    console.error(`Verification email failed for user ${user.id}: ${why}`);
    return "i couldn't send the verification email right now. send your @uw.edu address again in a bit (you're not verified yet).";
  }
  await q(
    `INSERT INTO email_codes (user_id, email, hash, salt, expires_at, attempts, sent_at) VALUES ($1, $2, $3, $4, $5, 0, $6)
     ON CONFLICT (user_id) DO UPDATE SET email = EXCLUDED.email, hash = EXCLUDED.hash, salt = EXCLUDED.salt,
       expires_at = EXCLUDED.expires_at, attempts = 0, sent_at = EXCLUDED.sent_at`,
    [user.id, email, hash, salt, new Date(t.getTime() + CODE_TTL_MS).toISOString(), t.toISOString()],
  );
  await q(`UPDATE users SET email = $2, email_verified = false, step = 'verify' WHERE id = $1`, [user.id, email]);
  return `sent a 6-digit code to ${email}. reply with it here, it expires in 10 minutes. not seeing it? check spam or junk. (text EMAIL to use a different address)`;
}

async function verify(user: User, said: string, word: string, t: Date): Promise<string> {
  if (word === 'EMAIL') {
    await setStep(user.id, 'email');
    return "sure, what's the @uw.edu address?";
  }
  const v = await one<{ email: string; hash: string; salt: string; expires_at: string; attempts: number }>(
    `SELECT email, hash, salt, expires_at, attempts FROM email_codes WHERE user_id = $1`,
    [user.id],
  );
  if (!v || v.attempts >= MAX_CODE_ATTEMPTS) {
    await setStep(user.id, 'email');
    return "send your @uw.edu address and i'll send you a fresh code.";
  }
  if (t.getTime() >= new Date(v.expires_at).getTime()) {
    await setStep(user.id, 'email');
    return "that code expired. send your @uw.edu address again and i'll send a new one.";
  }
  // "123 456", "my code is 123456" -> "123456". Chatter without digits ("where's my code?") isn't a guess and
  // doesn't use up an attempt.
  const guess = said.replace(/\D/g, '');
  if (!guess) return ASK_CODE;
  const ok = /^\d{6}$/.test(guess) && timingSafeEqual(await hashCode(guess, v.salt), Buffer.from(v.hash, 'hex'));
  if (!ok) {
    const attempts = v.attempts + 1;
    await q(`UPDATE email_codes SET attempts = $2 WHERE user_id = $1`, [user.id, attempts]);
    if (attempts >= MAX_CODE_ATTEMPTS) {
      await setStep(user.id, 'email');
      return 'too many wrong codes. send your @uw.edu address again for a new one.';
    }
    return "that code doesn't match. check your UW inbox and try again (text EMAIL to use a different address).";
  }
  // One statement, so two phones can't both claim the same address.
  const claimed = await q(
    `UPDATE users SET email = $2, email_verified = true, step = NULL
     WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM users o WHERE o.email = $2 AND o.email_verified AND o.id <> $1)
     RETURNING id`,
    [user.id, v.email],
  );
  if (!claimed.length) {
    await setStep(user.id, 'email');
    return EMAIL_TAKEN;
  }
  await q(`DELETE FROM email_codes WHERE user_id = $1`, [user.id]);
  await sendMixrCard(user);
  return braindumpPrompt(user.name);
}

// Right after verification, before the braindump prompt, once per user:
//   - Apple's Share Name and Photo for the bot account (best effort; a delivery-only signal, not in the chat log)
//   - mixr's contact card (name, photo, and the number this user texts mixr at). No assigned number = no card.
const SAVE_ME = "save me so you know it's me";
async function sendMixrCard(user: User): Promise<void> {
  if (config.imessageShareCard)
    await queueDelivery(user.id, null, '[share name and photo]', { dedupeKey: `share-card:${user.id}`, content: { kind: 'share_contact' } });
  const phone = user.assignedNumber;
  if (!phone) return;
  await send(user.id, `${SAVE_ME} ${cardLine('mixr', phone)}`, {
    dedupeKey: `mixr-card:${user.id}`,
    content: { kind: 'contact', first: 'mixr', phone, mixrPhoto: true, caption: SAVE_ME },
  });
}

const setStep = (userId: number, step: OnboardingStep): Promise<unknown> => q(`UPDATE users SET step = $2 WHERE id = $1`, [userId, step]);
