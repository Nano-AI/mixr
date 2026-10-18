import type { User } from '../types.ts';
import { getUser, q, toVec } from '../db/index.ts';
import { embedOne } from '../llm/embed.ts';
import { llm, pipelineLlm } from '../llm/index.ts';
import { registerJob } from '../jobs/index.ts';
import { trace } from '../trace.ts';
import { CANONICALIZE_SYSTEM, EDIT_SYSTEM, EVOLVE_SCHEMA, EVOLVE_SYSTEM, PROFILE_TEXT_SCHEMA } from './prompts.ts';

const HEADER = 'Core Interests:';
// tune: how many past YES events evolve_profile sees for context.
const PAST_YES_LIMIT = 10;

type EvolveResult = { action: 'no_update' | 'refine' | 'append'; profile_text: string; note: string };

// Numbered slot lines ("[3] ...") in a canonical profile, without the "[n] " prefix.
export function profileSlots(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.match(/^\s*\[\d+\]\s*(.+)$/)?.[1]?.trim())
    .filter((s): s is string => !!s);
}

// Append a slot to canonical text (fallback edit path), keeping the header and numbering intact.
export function appendSlot(text: string | null, slot: string): string {
  const slots = text ? profileSlots(text) : [];
  if (text && !slots.length && text.replace(HEADER, '').trim()) slots.push(text.replace(HEADER, '').trim());
  const clean = slot.trim().replace(/\s+/g, ' ');
  slots.push(/[.!?]$/.test(clean) ? clean : `${clean}.`);
  return [HEADER, ...slots.map((s, i) => `[${i + 1}] ${s}`)].join('\n');
}

const valid = (s: unknown): s is string => typeof s === 'string' && s.trim().length > 0;

async function llmProfileText(name: string, system: string, input: string): Promise<string | null> {
  if (!pipelineLlm(name)) return null;
  try {
    const r = await llm().json<{ profile_text: string }>({ name, system, input, schema: PROFILE_TEXT_SCHEMA, noThinking: true });
    return valid(r?.profile_text) ? r.profile_text.trim() : null;
  } catch {
    return null;
  }
}

// Braindump (everything the user said about themselves, consolidated by the agent) → canonical slot text → embedding.
// Saves name if given, sets state='active'. Returns the canonical profile text.
export async function buildProfile(userId: number, braindump: string, name?: string): Promise<string> {
  const before = (await getUser(userId))?.canonicalProfile ?? null;
  const viaLlm = await llmProfileText('canonicalize_profile', CANONICALIZE_SYSTEM, `Braindump:\n${braindump.trim()}`);
  const text = viaLlm ?? `${HEADER}\n[1] ${braindump.trim()}`;
  if (name?.trim()) await q('UPDATE users SET name = $2 WHERE id = $1', [userId, name.trim()]);
  await q(`UPDATE users SET state = 'active' WHERE id = $1`, [userId]);
  await setProfileText(userId, text);
  await trace('profile_update', userId, { op: 'build', llm: viaLlm !== null, before, after: text });
  return text;
}

// Explicit edit from the user ("add bouldering", "remove tennis, hurt my wrist"). Returns the new canonical text.
export async function editProfile(userId: number, change: string): Promise<string> {
  const user = await getUser(userId);
  if (!user) throw new Error(`no user ${userId}`);
  const before = user.canonicalProfile;
  const viaLlm = before
    ? await llmProfileText('edit_profile', EDIT_SYSTEM, `Current profile:\n${before}\n\nRequested change:\n${change.trim()}`)
    : await llmProfileText('canonicalize_profile', CANONICALIZE_SYSTEM, `Braindump:\n${change.trim()}`);
  const text = viaLlm ?? appendSlot(before, change);
  await setProfileText(userId, text);
  await trace('profile_update', userId, { op: 'edit', change, llm: viaLlm !== null, before, after: text });
  return text;
}

// Overwrite canonical text and re-embed in one step (the text and vector never drift apart).
export async function setProfileText(userId: number, text: string): Promise<User> {
  const v = await embedOne(text);
  await q('UPDATE users SET canonical_profile = $2, embedding = $3::vector WHERE id = $1', [userId, text, toVec(v)]);
  const u = await getUser(userId);
  if (!u) throw new Error(`no user ${userId}`);
  return u;
}

// Job 'evolve_profile' {userId, eventId}: learn from a YES RSVP in text space (no-op / refine slot / append slot).
export async function evolveFromRsvp(userId: number, eventId: number): Promise<void> {
  const user = await getUser(userId);
  const before = user?.canonicalProfile;
  if (!user || !before) return;
  const ev = (
    await q<{ title: string; raw_description: string; hyde_profile: string }>(
      'SELECT title, raw_description, hyde_profile FROM events WHERE id = $1',
      [eventId],
    )
  )[0];
  if (!ev) return;

  const base = { op: 'evolve', eventId, event: ev.title };
  if (!pipelineLlm('evolve_profile')) {
    await trace('profile_update', userId, { ...base, action: 'no_update', llm: false, note: 'pipeline LLM off; no-op fallback' });
    return;
  }

  const past = await q<{ title: string }>(
    `SELECT e.title FROM event_invites i JOIN events e ON e.id = i.event_id
     WHERE i.user_id = $1 AND i.status = 'yes' AND i.event_id <> $2
     ORDER BY i.responded_at DESC NULLS LAST LIMIT $3`,
    [userId, eventId, PAST_YES_LIMIT],
  );
  const input = [
    `Current profile:\n${before}`,
    `Event they just said yes to:\nTitle: ${ev.title}\nDescription: ${ev.raw_description}\nIdeal attendee:\n${ev.hyde_profile}`,
    `Past events they said yes to:\n${past.length ? past.map((p) => `- ${p.title}`).join('\n') : '(none)'}`,
  ].join('\n\n');

  let r: EvolveResult;
  try {
    r = await llm().json<EvolveResult>({ name: 'evolve_profile', system: EVOLVE_SYSTEM, input, schema: EVOLVE_SCHEMA });
  } catch (e) {
    await trace('profile_update', userId, { ...base, action: 'no_update', llm: false, note: `LLM error, no-op: ${String(e)}` });
    return;
  }

  const after = valid(r?.profile_text) ? r.profile_text.trim() : before;
  const changed = (r?.action === 'refine' || r?.action === 'append') && after !== before.trim();
  if (changed) await setProfileText(userId, after);
  await trace('profile_update', userId, {
    ...base,
    action: changed ? r.action : 'no_update',
    llm: true,
    note: r?.note ?? '',
    before,
    after: changed ? after : before,
  });
}

registerJob('evolve_profile', async (p: { userId: number; eventId: number }) => evolveFromRsvp(p.userId, p.eventId));
