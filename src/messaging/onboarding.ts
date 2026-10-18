import {
  randomBytes,
  randomInt,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import { db, tx } from '../db.ts';
import { getState, saveState } from './state.ts';
import { services, type Services } from './services.ts';
import { chatWithStudent } from './conversation.ts';

const brainPrompt =
  'What have you been into lately? Tell me a little about yourself—we can start anywhere.';
export const help =
  'PROFILE to review your interests; YES/PASS/CANCEL <invite number>; EVENTS; JOIN <event number>; WENT/MISSED feedback; EDIT interests; FREE availability; HELP; STOP to unsubscribe. Message frequency varies.';
export const consent =
  "Hey! I'm mixr. I find UW students with shared interests and organize small meetups. Reply YES to opt in to onboarding and meetup messages. Message frequency varies. Reply STOP anytime.";
export function setStep(id: number, step: string): void {
  db.prepare('UPDATE users SET step=? WHERE id=?').run(step, id);
}
function availabilityPrompt(id: number, deps: Services): string {
  const state = getState(id);
  state.slots = deps.upcomingSlots(new Date());
  saveState(id, state);
  if (!state.slots.length)
    return 'When are you free? Send one or more future start times with timezone offsets, separated by commas, e.g. 2026-11-01T17:00:00-08:00. Each time is a one-hour slot.';
  return (
    'When are you free? Reply with numbers, e.g. 1 3:\n' +
    state.slots
      .map(
        (s, i) =>
          `${i + 1}) ${new Date(s).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', timeZoneName: 'short' })}`,
      )
      .join('\n')
  );
}
export async function onboardingStep(
  id: number,
  text: string,
  deps: Services = services,
): Promise<string> {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(id)!;
  const state = getState(id);
  const normalized = text.trim().toUpperCase();
  switch (u.step) {
    case 'new':
      setStep(id, 'consent');
      return consent;
    case 'consent':
      if (!['YES', 'I AGREE', 'OPT IN'].includes(normalized)) return consent;
      state.consentAt = new Date().toISOString();
      saveState(id, state);
      setStep(id, 'name');
      return "What's your first name?";
    case 'name':
      if (!text.trim() || text.length > 80)
        return 'Please send your first name (up to 80 characters).';
      db.prepare("UPDATE users SET name=?, step='email' WHERE id=?").run(
        text.trim(),
        id,
      );
      return `Nice to meet you, ${text.trim()}. What's your @uw.edu email?`;
    case 'email': {
      const email = text.trim().toLowerCase();
      if (!/^[^\s@]+@uw\.edu$/.test(email) || email.length > 254)
        return 'That needs to be a @uw.edu address.';
      if (
        db
          .prepare(
            'SELECT id FROM users WHERE email=? AND email_verified=1 AND id<>?',
          )
          .get(email, id)
      )
        return 'That email is already connected to another messaging identity. Contact the organizer for help.';
      if (state.verification && Date.now() - state.verification.sent < 60_000)
        return 'Please wait one minute before requesting another email code.';
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      const salt = randomBytes(16).toString('hex');
      try {
        await deps.sendCode(email, code);
      } catch {
        return 'I could not send your verification email. Please try your @uw.edu address again later. You have not been verified.';
      }
      state.verification = {
        hash: scryptSync(code, salt, 32).toString('hex'),
        salt,
        expires: Date.now() + 600_000,
        attempts: 0,
        sent: Date.now(),
      };
      saveState(id, state);
      db.prepare(
        "UPDATE users SET email=?, email_verified=0, step='verify' WHERE id=?",
      ).run(email, id);
      return 'Check your UW inbox for a six-digit code and reply with it. It expires in 10 minutes. EMAIL lets you change the address.';
    }
    case 'verify': {
      const v = state.verification;
      if (normalized === 'EMAIL') {
        setStep(id, 'email');
        return 'Send your @uw.edu address.';
      }
      if (!v || Date.now() > v.expires) {
        setStep(id, 'email');
        return 'Your code expired. Send your @uw.edu address for a new code.';
      }
      if (
        !/^\d{6}$/.test(text.trim()) ||
        !timingSafeEqual(
          scryptSync(text.trim(), v.salt, 32),
          Buffer.from(v.hash, 'hex'),
        )
      ) {
        v.attempts++;
        saveState(id, state);
        if (v.attempts >= 3) {
          setStep(id, 'email');
          return 'Too many incorrect codes. Send your @uw.edu address for a new code.';
        }
        return 'That code does not match. Check your UW inbox and try again.';
      }
      if (
        db
          .prepare(
            'SELECT id FROM users WHERE email=? AND email_verified=1 AND id<>?',
          )
          .get(String(u.email), id)
      ) {
        setStep(id, 'email');
        return 'That email is already connected to another messaging identity.';
      }
      delete state.verification;
      saveState(id, state);
      db.prepare(
        "UPDATE users SET email_verified=1, step='braindump' WHERE id=?",
      ).run(id);
      return brainPrompt;
    }
    case 'braindump':
    case 'confirm': {
      if (!u.email_verified) {
        setStep(id, 'email');
        return 'First, send your @uw.edu email for verification.';
      }
      if (
        u.step === 'confirm' &&
        ['OK', 'YES', 'LOOKS GOOD', '👍'].includes(normalized)
      ) {
        deps.confirmProfile(id);
        db.prepare('UPDATE profiles SET confirmed=1 WHERE user_id=?').run(id);
        state.onboarded = true;
        saveState(id, state);
        setStep(id, 'active');
        return "Got it—I've saved your profile. We can keep chatting; tell me whenever your interests change.";
      }
      if (u.step === 'braindump' && normalized !== 'PROFILE')
        return chatWithStudent(id, text, deps.converse);
      const previous = state.draft ?? '';
      const draft = u.step === 'braindump'
        ? previous || state.interestNotes || ''
        : `${previous}\nCorrection: ${text}`;
      if (!draft.trim()) return 'Tell me a little about your interests first, then send PROFILE to review them.';
      const p = await deps.buildProfile(id, draft);
      state.draft = draft;
      state.interestNotes = p.summary.slice(0, 2000);
      saveState(id, state);
      db.prepare(
        "INSERT INTO profiles(user_id,braindump,data,confirmed) VALUES (?,?,?,0) ON CONFLICT(user_id) DO UPDATE SET braindump=excluded.braindump,data=excluded.data,confirmed=0,updated_at=datetime('now')",
      ).run(id, draft, JSON.stringify(p));
      if (p.question) {
        setStep(id, 'braindump');
        return p.question;
      }
      setStep(id, 'confirm');
      return `Here's what I got: ${p.summary}\nInterests: ${p.interests.map((i) => i.label).join(', ')}\nReply OK, or tell me what to fix.`;
    }
    case 'availability': {
      if (normalized === 'FREE') return availabilityPrompt(id, deps);
      const menu = state.slots ?? [];
      let selected: string[] = [];
      if (menu.length) {
        const parts = text.trim().split(/[\s,]+/);
        if (
          !parts.every(
            (p) => /^\d+$/.test(p) && Number(p) > 0 && Number(p) <= menu.length,
          )
        )
          return 'Choose only numbers from the availability menu, or send FREE for a fresh menu.';
        selected = parts.map((p) => menu[Number(p) - 1]);
      } else {
        const parts = text.split(',').map((s) => s.trim());
        if (
          !parts.length ||
          parts.length > 30 ||
          !parts.every(
            (s) =>
              /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:\d{2})$/.test(
                s,
              ) && Number.isFinite(Date.parse(s)),
          )
        )
          return 'Send ISO start times with timezone offsets, separated by commas.';
        selected = parts.map((s) => new Date(s).toISOString());
      }
      if (selected.some((s) => Date.parse(s) <= Date.now()))
        return 'Those times have passed. Send FREE to choose new times.';
      tx(() => {
        db.prepare('DELETE FROM availability WHERE user_id=?').run(id);
        for (const s of new Set(selected))
          db.prepare('INSERT INTO availability(user_id,slot) VALUES (?,?)').run(
            id,
            s,
          );
        setStep(id, state.onboarded ? 'active' : 'mode');
      });
      if (state.onboarded) {
        try { await deps.planMeetups(new Date()); }
        catch { console.error('Meetup planning failed; scheduler can retry.'); }
        return 'Your availability is updated.';
      }
      return 'Last one: 1) 1:1 intros 2) small groups 3) both';
    }
    case 'mode': {
      const mode = (
        { '1': 'pair', '2': 'group', '3': 'both' } as Record<string, string>
      )[text.trim()];
      if (!mode)
        return 'Reply 1 for 1:1 intros, 2 for small groups, or 3 for both.';
      state.onboarded = true;
      saveState(id, state);
      db.prepare("UPDATE users SET mode=?, step='active' WHERE id=?").run(
        mode,
        id,
      );
      try {
        await deps.planMeetups(new Date());
      } catch {
        console.error('Meetup planning failed; scheduler can retry.');
      }
      return `You're in. I'll text when I find your people. ${help}`;
    }
    case 'active':
      return chatWithStudent(id, text, deps.converse);
    default:
      return help;
  }
}
