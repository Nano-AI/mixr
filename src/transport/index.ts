import { q, one, getUser } from '../db/index.ts';
import { publish } from '../bus.ts';
import { now } from '../clock.ts';
import { deliversTo, queueDelivery, type RichContent } from './outbox.ts';

// The seam between mixr and a phone. Every message is logged here (the dashboard reads it); outbound texts to
// real users are additionally queued for iMessage delivery by the outbox when the context allows it.

export type SendOpts = {
  dedupeKey?: string; // one logical notification = one key, so retries and replays never double-text
  evenIfOptedOut?: boolean; // only the STOP acknowledgement
  content?: RichContent; // native iMessage form of this text (contact card, effect...); `text` is the fallback
};

export async function send(userId: number, text: string, opts: SendOpts = {}): Promise<void> {
  const note = await takeNote(userId, opts);
  const body = note ? withNote(note, text) : text;
  const content = note && opts.content?.caption ? { ...opts.content, caption: withNote(note, opts.content.caption) } : opts.content;
  const messageId = await log(userId, 'out', body);
  await queueDelivery(userId, messageId, body, { ...opts, content });
}

// An operator's one-time note (users.pending_note, set by POST /api/admin/note) leads the next text that's actually
// queued for delivery to them, then it's gone. A text that only lands in the log (the dashboard acting as them, the
// sim transport, opted out) or that shows no words (a tapback, a bare card) leaves it for the next one, and so does
// the STOP acknowledgement. Taken atomically, so it goes out once.
async function takeNote(userId: number, opts: SendOpts): Promise<string | null> {
  if (opts.evenIfOptedOut || !showsText(opts.content) || !(await deliversTo(userId, opts))) return null;
  if (opts.dedupeKey && (await one('SELECT 1 FROM message_jobs WHERE dedupe_key = $1', [opts.dedupeKey]))) return null; // a repeat; not queued again
  const r = await one<{ note: string }>(
    `WITH old AS (SELECT id, pending_note FROM users WHERE id = $1 AND pending_note IS NOT NULL FOR UPDATE)
     UPDATE users u SET pending_note = NULL FROM old WHERE u.id = old.id RETURNING old.pending_note AS note`,
    [userId],
  );
  return r?.note ?? null;
}

// Rich forms whose delivery carries the text (or a caption the note can lead).
const showsText = (c: RichContent | undefined): boolean => !c || c.kind === 'effect' || c.kind === 'reply' || !!c.caption;
// "<note> <text>", the note its own sentence.
const withNote = (note: string, text: string): string => `${note}${/[\p{L}\p{N}]$/u.test(note) ? '.' : ''} ${text}`;

// "+14255183059" -> "(425) 518-3059"; other countries stay E.164.
export const prettyPhone = (e164: string): string => e164.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, '($1) $2-$3');
// The log line (and plain fallback) for a contact card.
export const cardLine = (name: string, phone: string): string => `[contact card: ${name}, ${prettyPhone(phone)}]`;

// via: 'dashboard' when someone typed it in the simulator rather than on a phone. Returns the message id.
export async function recordInbound(userId: number, text: string, via: 'phone' | 'dashboard' = 'phone'): Promise<number> {
  return log(userId, 'in', text, via);
}

async function log(userId: number, direction: 'in' | 'out', text: string, via = 'system'): Promise<number> {
  const t = (await now()).toISOString();
  const r = await one<{ id: number }>('INSERT INTO messages (user_id, direction, text, sim_time, via) VALUES ($1, $2, $3, $4, $5) RETURNING id', [
    userId,
    direction,
    text,
    t,
    direction === 'out' ? 'system' : via,
  ]);
  const u = await getUser(userId);
  publish({ type: 'message', userId, phone: u?.phone ?? '', direction, text, simTime: t });
  return r!.id;
}

export async function history(userId: number, limit = 30): Promise<{ direction: 'in' | 'out'; text: string; simTime: string }[]> {
  const rows = await q<{ direction: 'in' | 'out'; text: string; sim_time: string }>(
    'SELECT direction, text, sim_time FROM messages WHERE user_id = $1 ORDER BY id DESC LIMIT $2',
    [userId, limit],
  );
  return rows.reverse().map((r) => ({ direction: r.direction, text: r.text, simTime: new Date(r.sim_time).toISOString() }));
}
