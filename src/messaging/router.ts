import { db, tx } from '../db.ts';
import type { Inbound, Reply } from '../types.ts';
import { getState, saveState } from './state.ts';
import { help, onboardingStep, setStep } from './onboarding.ts';
import { sendMessage } from './send.ts';
import { services, type Services } from './services.ts';
export const STOP_WORDS = ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'END', 'QUIT'];
export const REPLY_WORDS = ['YES', 'PASS', 'CANCEL'];

export function createRouter(overrides: Partial<Services> = {}) {
  const deps = { ...services, ...overrides };
  // Serialize transitions, including duplicate deliveries arriving while an API call is in flight.
  let queue: Promise<void> = Promise.resolve();
  async function processInbound(m: Inbound): Promise<void> {
    if (
      !/^\+[1-9]\d{7,14}$/.test(m.from) ||
      !m.providerId ||
      m.providerId.length > 500 ||
      typeof m.text !== 'string' ||
      m.text.length > 10000
    )
      return;
    const before = db
      .prepare('SELECT step FROM users WHERE phone=?')
      .get(m.from);
    const storedText =
      before?.step === 'verify' ? '[verification response redacted]' : m.text;
    const inserted = tx(() => {
      const r = db
        .prepare(
          'INSERT OR IGNORE INTO inbound_messages(provider_id,phone,text) VALUES (?,?,?)',
        )
        .run(m.providerId, m.from, storedText);
      if (r.changes)
        db.prepare(
          "INSERT INTO inbound_processing(provider_id,status) VALUES (?,'processing')",
        ).run(m.providerId);
      return r.changes;
    });
    if (!inserted) return;
    let userId: number | undefined;
    try {
      db.prepare(
        'INSERT INTO users(phone) VALUES (?) ON CONFLICT(phone) DO NOTHING',
      ).run(m.from);
      const user = db.prepare('SELECT * FROM users WHERE phone=?').get(m.from)!;
      const id = Number(user.id);
      userId = id;
      const onboarded =
        user.step === 'active' || getState(id).onboarded === true;
      const text = m.text
        .trim()
        .replace(/\s+/g, ' ')
        .replace(/[!.?]+$/, '');
      const word = text.split(' ')[0].toUpperCase();
      const reply = (body: string) =>
        sendMessage(id, body, `reply:${m.providerId}`);
      if (STOP_WORDS.includes(word)) {
        tx(() => {
          db.prepare('UPDATE users SET opted_out=1 WHERE id=?').run(id);
          db.prepare(
            "UPDATE message_jobs SET status='failed',error='Suppressed after STOP' WHERE user_id=? AND status IN ('pending','failed') AND dedupe_key NOT LIKE 'stop-ack:%'",
          ).run(id);
        });
        // Consent takes effect before any asynchronous cancellation/delivery work.
        for (const [kind, answer] of [
          ['cancel', 'cancel'],
          ['yes', 'pass'],
        ] as const) {
          for (const meetupId of deps.openInvitations(id, kind)) {
            try {
              await deps.recordResponse(id, meetupId, answer);
            } catch {
              console.error(
                `Opt-out cancellation failed for user ${id}, meetup ${meetupId}`,
              );
            }
          }
        }
        await sendMessage(
          id,
          "You're unsubscribed from mixr. Reply START to come back.",
          `stop-ack:${m.providerId}`,
        );
      } else if (user.opted_out && word !== 'START') {
        // Deliberately silent.
      } else if (word === 'START') {
        db.prepare('UPDATE users SET opted_out=0 WHERE id=?').run(id);
        if (user.step === 'active') await reply(`Welcome back. ${help}`);
        else {
          setStep(id, 'consent');
          await reply(await onboardingStep(id, '', deps));
        }
      } else if (word === 'HELP') await reply(help);
      else if (
        REPLY_WORDS.includes(word) &&
        (user.step === 'active' ||
          /^\w+\s+\d+$/.test(text) ||
          (onboarded && ['PASS', 'CANCEL'].includes(word)))
      ) {
        if (!user.email_verified || !onboarded)
          await reply(
            'Finish onboarding and verify your UW email before responding to meetups.',
          );
        else {
          const match = /^(YES|PASS|CANCEL)(?:\s+([1-9]\d*))?$/i.exec(text);
          if (!match || (match[2] && !Number.isSafeInteger(Number(match[2]))))
            await reply(`Use ${word} followed by the invitation number.`);
          else {
            const answer = word.toLowerCase() as Reply;
            const ids = match[2]
              ? [Number(match[2])]
              : deps.openInvitations(id, answer);
            if (!ids.length) await reply('No open invites right now.');
            else if (ids.length > 1)
              await reply(
                `Which one? Reply ${ids.map((n) => `${word} ${n}`).join(' or ')}`,
              );
            else {
              const result = await deps.recordResponse(id, ids[0], answer);
              const messages = {
                accepted:
                  'Your RSVP is recorded. We will confirm once enough people accept.',
                confirmed:
                  'Your meetup is confirmed. Watch for the meetup details.',
                declined: 'You passed on that invite.',
                cancelled: 'Your RSVP is cancelled.',
                full: 'That meetup is full.',
                closed: 'That meetup is closed.',
                not_invited: 'You do not have an invitation to that meetup.',
              };
              await reply(messages[result.outcome]);
            }
          }
        }
      } else {
        if (user.step === 'active' && word === 'EDIT') {
          const state = getState(id);
          delete state.draft;
          saveState(id, state);
          setStep(id, 'braindump');
          await reply(
            'Tell me your updated interests and what you want to try.',
          );
        } else if (user.step === 'active' && word === 'FREE') {
          setStep(id, 'availability');
          await reply(await onboardingStep(id, 'FREE', deps));
        } else await reply(await onboardingStep(id, m.text.trim(), deps));
      }
      db.prepare(
        "UPDATE inbound_processing SET status='done',error=NULL WHERE provider_id=?",
      ).run(m.providerId);
    } catch {
      db.prepare(
        "UPDATE inbound_processing SET status='failed',error='Conversation processing failed; inspect integration health' WHERE provider_id=?",
      ).run(m.providerId);
      console.error('Inbound processing failed; recorded for inspection.');
      if (userId)
        await sendMessage(
          userId,
          'Something went wrong. Please try your message again.',
          `error:${m.providerId}`,
        );
    }
  }
  return (m: Inbound): Promise<void> => {
    const next = queue.then(() => processInbound(m));
    queue = next.catch(() => {});
    return next;
  };
}
export const handleInbound = createRouter();
