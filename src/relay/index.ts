import type { Intro, User } from '../types.ts';
import { getUser, one, q } from '../db/index.ts';
import { HOUR, now } from '../clock.ts';
import { registerJob, schedule } from '../jobs/index.ts';
import { send, type SendOpts } from '../transport/index.ts';
import { publish } from '../bus.ts';
import { firstName } from '../matching/index.ts';

// tune: how long a target has to answer an intro before it lapses.
const INTRO_TTL = 24 * HOUR;

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
  const r = await one(
    `INSERT INTO intros (requester_id, target_id, reason, status, created_at) VALUES ($1, $2, $3, 'target_asked', $4) RETURNING ${COLS}`,
    [requesterId, targetId, reason.trim(), t.toISOString()],
  );
  const intro = rowToIntro(r!);
  await send(
    targetId,
    `hey ${firstName(target.name)}! ${firstName(requester.name)} on campus is looking for ${clause(reason)}. want me to connect you two?`,
  );
  await schedule('expire_intro', { introId: intro.id }, new Date(t.getTime() + INTRO_TTL));
  publish({ type: 'state' });
  return intro;
}

// Once both said yes: the other person's contact card (first + last name, phone) with a short caption. The plain
// text with the number stays the log line and the fallback if iMessage rejects the card.
function card(u: User | undefined, caption: string): SendOpts {
  if (!u?.phone) return {};
  const [, ...rest] = (u.name ?? '').trim().split(/\s+/);
  return { content: { kind: 'contact', first: firstName(u.name), ...(rest.length ? { last: rest.join(' ') } : {}), phone: u.phone, caption } };
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
    const said = msg ? ` they said: "${msg}".` : '';
    await send(intro.requesterId, `${tName} is down!${said} their number: ${target?.phone ?? ''}`, card(target, `${tName} is down!${said} here's their contact`));
    await send(intro.targetId, `done! here's ${rName}'s number: ${requester?.phone ?? ''}. have fun!`, card(requester, `done! here's ${rName}'s contact. have fun!`));
    return updated;
  }
  const updated = await setStatus(introId, 'declined', msg);
  await send(intro.requesterId, `heads up, ${tName} can't make it work right now. no worries, i'll keep an eye out for other people for you.`);
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
  await send(intro.requesterId, `didn't hear back from ${firstName(target?.name)}, so i'll let that one go. happy to find you someone else!`);
}

registerJob('expire_intro', async (p: { introId: number }) => expireIntro(p.introId));
