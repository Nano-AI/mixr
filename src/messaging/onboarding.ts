import { randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';
import { one, q } from '../db/index.ts';
import { MINUTE, now } from '../clock.ts';
import type { OnboardingStep, User } from '../types.ts';
import { createEmailSender, type CodeSender } from './email.ts';

// Real users before the agent takes over, deterministic (no LLM): consent -> name -> email -> verify.
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
const CONSENT_WORDS = ['YES', 'Y', 'I AGREE', 'OPT IN'];
const ASK_NAME = "what's your first name?";
const ASK_EMAIL = "what's your @uw.edu email? i use it to keep mixr UW-only.";
const ASK_CODE = 'reply with the 6-digit code from your UW inbox, or text EMAIL to use a different address.';
const EMAIL_TAKEN = "that email is already connected to another mixr account. if that's not right, reach out to the mixr team.";
export const CODE_PLACEHOLDER = '[verification code]';

// The first thing the agent's onboarding builds on: the user has a name, now they braindump.
export const braindumpPrompt = (name: string | null): string =>
  `you're verified${name ? `, ${name}` : ''}! now the fun part: braindump me what you're into. sports, games, music, hobbies, things you want to try, and how serious you are about each. the more you tell me, the better i can match you.`;

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
  // A YES only counts once they've seen what they're agreeing to (a first text of "yes" gets the disclosure).
  const prompted = await one(`SELECT 1 FROM messages WHERE user_id = $1 AND direction = 'out' AND text = $2 LIMIT 1`, [user.id, CONSENT]);
  if (!prompted || !CONSENT_WORDS.includes(word)) {
    if (user.step !== 'consent') await setStep(user.id, 'consent');
    return CONSENT;
  }
  await q(`UPDATE users SET consent_at = $2, step = 'name' WHERE id = $1`, [user.id, t.toISOString()]);
  return `you're in! ${ASK_NAME}`;
}

// "i'm ana!" -> "ana". Names show up in other people's texts and in the agent's context, so only letters,
// spaces, apostrophes, hyphens and periods, a few words at most; a repeated YES isn't a name either.
export function cleanName(said: string): string | null {
  const name = said
    .replace(/^(hi|hey|hello|yo)\b[\s,!.]*/i, '')
    .replace(/^(i'?m|i am|my name is|my name'?s|it'?s|this is|call me|name'?s)\s+/i, '')
    .replace(/[\s.!?,]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!name || name.length > NAME_MAX || !/^[\p{L}\p{M}'’. -]+$/u.test(name) || name.split(' ').length > NAME_WORDS) return null;
  if (CONSENT_WORDS.includes(name.toUpperCase())) return null;
  return name;
}

// "it's Ana@UW.edu." -> "ana@uw.edu" (validated by the caller).
export const extractEmail = (said: string): string =>
  (said.toLowerCase().match(/[^\s<>()"',;:]+@[^\s<>()"',;:]+/)?.[0] ?? '').replace(/[.!?]+$/, '');

async function takeName(user: User, said: string): Promise<string> {
  const name = cleanName(said);
  if (!name) return `${ASK_NAME} (just your first name, up to ${NAME_MAX} characters)`;
  await q(`UPDATE users SET name = $2, step = 'email' WHERE id = $1`, [user.id, name]);
  return `nice to meet you, ${name}! ${ASK_EMAIL}`;
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
  return `sent a 6-digit code to ${email}. reply with it here, it expires in 10 minutes. (text EMAIL to use a different address)`;
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
  return braindumpPrompt(user.name);
}

const setStep = (userId: number, step: OnboardingStep): Promise<unknown> => q(`UPDATE users SET step = $2 WHERE id = $1`, [userId, step]);
