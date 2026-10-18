import type { Intro, User } from '../types.ts';
import { getUser, one, q } from '../db/index.ts';
import { HOUR, now } from '../clock.ts';
import { registerJob, schedule } from '../jobs/index.ts';
import { send, type SendOpts } from '../transport/index.ts';
import { publish } from '../bus.ts';
import { firstName } from '../matching/index.ts';

// tune: how long a target has to answer an intro before it lapses.
const INTRO_TTL = 24 * HOUR;
// tune: intro requests one student can start in a rolling 24h (events are the way to reach more people).
export const INTRO_LIMIT = 3;

// Over the daily limit. The message goes back to the agent as-is.
export class IntroLimitError extends Error {}

const COLS = 'id, requester_id, target_id, reason, status, target_message';

function rowToIntro(r: Record<string, any>): Intro {
  return { id: r.id, requesterId: r.requester_id, targetId: r.target_id, reason: r.reason, status: r.status, targetMessage: r.target_message };
}

export async function getIntro(id: number): Promise<Intro | undefined> {
  const r = await one(`SELECT ${COLS} FROM intros WHERE id = $1`, [id]);
  return r && rowToIntro(r);
}

async function setStatus(id: number, status: Intro['status'], message: string | null = null): Promise<Intro> {
  const r = await one(`UPDATE intros SET status = $2, target_message = COALESCE($3, target_message) WHERE id = $1 RETURNING ${COLS}`, [id, status, message]);
  publish({ type: 'state' });
  return rowToIntro(r!);
}

// Strip a trailing period so the reason reads naturally mid-sentence.
const clause = (s: string) => s.trim().replace(/[.!\s]+$/, '');
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The intro ask's middle, from whatever reason the agent passed: a noun phrase ("a 4.5 hitting partner"), or a
// sentence about the requester ("Maya is into hackathons...", "is into chess", "into chess"). Names the requester
// once, by first name only (a full name in the reason never leaks the last name).
export function introLine(requesterName: string | null | undefined, reason: string): string {
  const name = firstName(requesterName);
  let r = clause(reason);
  for (const n of [requesterName?.trim(), name]) {
    if (n) r = r.replace(new RegExp(`^${escapeRe(n)}(?:['’]s)?\\b`, 'i'), (m) => (/['’]s$/i.test(m) ? 'is' : '')).trim();
  }
  if (/^(is|was|has|wants|would|likes|loves|enjoys|plays|needs|does|can|just|really|also|mostly)\b/i.test(r)) return `${name} ${r}`;
  if (/^(looking|hoping|trying|into|down|new|interested|keen)\b/i.test(r)) return `${name} is ${r}`;
  // "A chess partner" -> "a chess partner", but leave acronyms ("AI startups") alone.
  const np = /^[A-Z](?![A-Z])/.test(r) ? r[0].toLowerCase() + r.slice(1) : r;
  return `${name} on campus is looking for ${np}`;
}

// Requester said yes to a match: create the intro and text the target asking if they're open to it.
export async function requestIntro(requesterId: number, targetId: number, reason: string): Promise<Intro> {
  if (requesterId === targetId) throw new Error('cannot intro someone to themselves');
  const [requester, target] = await Promise.all([getUser(requesterId), getUser(targetId)]);
  if (!requester || !target) throw new Error(`unknown user ${!requester ? requesterId : targetId}`);

  const open = await one(
    `SELECT ${COLS} FROM intros WHERE requester_id = $1 AND target_id = $2 AND status IN ('proposed', 'target_asked') ORDER BY id DESC LIMIT 1`,
    [requesterId, targetId],
  );
  if (open) return rowToIntro(open);

  const t = await now();
  const recent = await one<{ n: number }>(`SELECT count(*)::int AS n FROM intros WHERE requester_id = $1 AND created_at > $2`, [
    requesterId,
    new Date(t.getTime() - 24 * HOUR).toISOString(),
  ]);
  if (recent!.n >= INTRO_LIMIT) {
    throw new IntroLimitError(
      `daily limit: they already asked mixr to reach out to ${INTRO_LIMIT} people in the last 24h, nobody was asked. tell them something like "you've asked me to reach out to ${INTRO_LIMIT} people today. i'll be able to ask more tomorrow, or want me to host an event instead?"`,
    );
  }
  const r = await one(
    `INSERT INTO intros (requester_id, target_id, reason, status, created_at) VALUES ($1, $2, $3, 'target_asked', $4) RETURNING ${COLS}`,
    [requesterId, targetId, reason.trim(), t.toISOString()],
  );
  const intro = rowToIntro(r!);
  await send(
    targetId,
    `hey ${firstName(target.name)}! ${introLine(requester.name, reason)}. want me to connect you two?`,
  );
  await schedule('expire_intro', { introId: intro.id }, new Date(t.getTime() + INTRO_TTL));
  publish({ type: 'state' });
  return intro;
}

// A note the agent wants to pass on as the target's words. Kept only if it's the target's own words from the text
// they just sent (a substring, ignoring case and punctuation) and says more than "yes": the model never authors a
// quote. "sure, tell them i play saturdays" + "i play saturdays" -> kept; "Yes!" + "Casey's in, say hi!" -> dropped.
const ACCEPT_WORDS = new Set(
  'yes yeah yea yep yup ya sure ok okay k bet down im i am in totally definitely absolutely for sure sounds good great cool def please pls of course course lets go do it'.split(
    ' ',
  ),
);
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
export function groundedNote(note: string | null | undefined, inbound: string | undefined): string | undefined {
  const n = norm(note ?? '');
  if (!n || inbound === undefined || !` ${norm(inbound)} `.includes(` ${n} `)) return undefined;
  if (n.split(' ').every((w) => ACCEPT_WORDS.has(w))) return undefined;
  return note!.trim();
}

// Once both said yes: the other person's contact card (first + last name, phone) with a short caption that goes out
// with confetti. The plain text with the number stays the log line and the fallback if iMessage rejects the card.
function card(u: User | undefined, caption: string): SendOpts {
  if (!u?.phone) return {};
  const [, ...rest] = (u.name ?? '').trim().split(/\s+/);
  return { content: { kind: 'contact', first: firstName(u.name), ...(rest.length ? { last: rest.join(' ') } : {}), phone: u.phone, caption, captionEffect: 'confetti' } };
}

// Target answered. On accept, relay their message (and that they're happy to share their number) to the requester.
export async function respondToIntro(targetId: number, introId: number, accept: boolean, message?: string): Promise<Intro> {
  const intro = await getIntro(introId);
  if (!intro || intro.targetId !== targetId) throw new Error(`intro ${introId} is not waiting on user ${targetId}`);
  if (intro.status !== 'target_asked' && intro.status !== 'proposed') return intro; // already answered or lapsed

  const [requester, target] = await Promise.all([getUser(intro.requesterId), getUser(intro.targetId)]);
  const rName = firstName(requester?.name);
  const tName = firstName(target?.name);
  const msg = message?.trim() || null;

  if (accept) {
    const updated = await setStatus(introId, 'connected', msg);
    // Their note in quotes, its own end punctuation dropped so it never reads `"say hi!".`
    const note = msg?.replace(/[.!\s]+$/, '');
    const said = note ? ` they said: "${note}"${note.endsWith('?') ? '' : '.'}` : '';
    // The card carries the caption; the plain text (with the number) is the log line and the fallback.
    await send(intro.requesterId, `${tName}'s down.${said} here's their number: ${target?.phone ?? ''}`, card(target, `${tName}'s down.${said} here's their contact`));
    await send(intro.targetId, `done, here's ${rName}'s number: ${requester?.phone ?? ''}. have fun`, card(requester, `done, here's ${rName}'s contact. have fun`));
    return updated;
  }
  const updated = await setStatus(introId, 'declined', msg);
  await send(intro.requesterId, `${tName} can't right now, no worries. i'll keep an eye out for someone else for you.`);
  return updated;
}

// Intros where this user is the target and hasn't answered yet (agent context).
export async function pendingIntrosFor(userId: number): Promise<Intro[]> {
  const rows = await q(`SELECT ${COLS} FROM intros WHERE target_id = $1 AND status IN ('proposed', 'target_asked') ORDER BY id`, [userId]);
  return rows.map(rowToIntro);
}

// Job 'expire_intro' {introId}: the target never answered.
export async function expireIntro(introId: number): Promise<void> {
  const intro = await getIntro(introId);
  if (!intro || (intro.status !== 'target_asked' && intro.status !== 'proposed')) return;
  await setStatus(introId, 'expired');
  const target = await getUser(intro.targetId);
  await send(intro.requesterId, `didn't hear back from ${firstName(target?.name)}, so i'll let that one go. hmu if you want me to find someone else`);
}

registerJob('expire_intro', async (p: { introId: number }) => expireIntro(p.introId));
