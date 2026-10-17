import type { PersonMatch, RecallHit, RerankPick } from '../types.ts';
import { getUser, q, toVec } from '../db/index.ts';
import { now } from '../clock.ts';
import { embedOne } from '../llm/embed.ts';
import { llm, pipelineLlm } from '../llm/index.ts';
import { trace } from '../trace.ts';
import { profileSlots } from '../profiles/index.ts';
import { RERANK_SCHEMA, RERANK_SYSTEM } from './prompts.ts';

// tune: stage-1 recall size (cheap, tolerant of polymaths' diluted vectors).
const RECALL_LIMIT = 40;
// tune: how many recall hits the trace keeps for the inspector.
const TRACE_HITS = 12;
// tune: default number of people findPeople returns.
const PEOPLE_K = 3;
// tune: max words of a profile slot quoted in a fallback pitch.
const PITCH_WORDS = 8;

export type RecallOpts = { exclude?: number[]; limit?: number; refId?: number | null; label?: string };

const r3 = (x: number) => Math.round(x * 1000) / 1000;
export const firstName = (name: string | null | undefined): string => (name ?? '').trim().split(/\s+/)[0] || 'someone';

// Stage 1: pgvector cosine top-N over active, non-snoozed users with an embedding.
export async function recall(vector: number[], opts: RecallOpts = {}): Promise<RecallHit[]> {
  const limit = opts.limit ?? RECALL_LIMIT;
  const exclude = opts.exclude ?? [];
  const t = await now();
  const rows = await q<{ id: number; name: string | null; canonical_profile: string | null; similarity: number }>(
    `SELECT id, name, canonical_profile, 1 - (embedding <=> $1::vector) AS similarity
     FROM users
     WHERE state = 'active' AND embedding IS NOT NULL
       AND (snoozed_until IS NULL OR snoozed_until <= $2)
       AND NOT (id = ANY($3::int[]))
     ORDER BY embedding <=> $1::vector, id
     LIMIT $4`,
    [toVec(vector), t.toISOString(), exclude, limit],
  );
  const hits: RecallHit[] = rows.map((r) => ({
    userId: r.id,
    name: r.name ?? '',
    profile: r.canonical_profile ?? '',
    similarity: Number(r.similarity),
  }));
  await trace('recall', opts.refId ?? null, {
    label: opts.label ?? null,
    limit,
    excluded: exclude.length,
    count: hits.length,
    hits: hits.slice(0, TRACE_HITS).map((h) => ({ userId: h.userId, name: h.name, similarity: r3(h.similarity) })),
  });
  return hits;
}

// Short phrase from a profile's first slot, for template pitches: "competitive tennis, varsity match play".
export function topInterest(profile: string): string {
  const slot = profileSlots(profile)[0] ?? profile.replace(/^Core Interests:\s*/i, '');
  const stripped = slot.replace(/\((Level|Vibe):[^)]*\)/gi, '').replace(/[\s.]+$/, '').trim();
  const words = stripped.split(/\s+/).filter(Boolean);
  const phrase = words.slice(0, PITCH_WORDS).join(' ').replace(/[,;:]+$/, '');
  if (!phrase) return 'stuff like this';
  return phrase.charAt(0).toLowerCase() + phrase.slice(1);
}

function fallbackPick(purpose: RerankReq['purpose'], c: RecallHit): RerankPick {
  const topic = topInterest(c.profile);
  return {
    userId: c.userId,
    reason: purpose === 'people' ? `into ${topic}` : `close fit: ${topic}`,
    pitch: `thought of you since you're into ${topic}.`,
  };
}

// Stage 2: LLM picks up to k best candidates for `target` and writes a reason + 1-sentence SMS pitch for each.
// May return fewer than k (drops poor fits). Fallback without LLM: top-k by similarity, template pitch.
export type RerankReq = { purpose: 'event' | 'people'; target: string; candidates: RecallHit[]; k: number; refId?: number | null };
export async function rerank(req: RerankReq): Promise<RerankPick[]> {
  const k = Math.max(0, Math.floor(req.k));
  if (!req.candidates.length || k === 0) return [];
  const byId = new Map(req.candidates.map((c) => [c.userId, c]));

  let picks: RerankPick[] | null = null;
  if (pipelineLlm('rerank')) {
    try {
      const input = [
        `PURPOSE: ${req.purpose}`,
        `TARGET:\n${req.target}`,
        `K: ${k}`,
        `CANDIDATES:\n${req.candidates
          .map((c) => `--- user_id: ${c.userId} | name: ${firstName(c.name)} | similarity: ${r3(c.similarity)}\n${c.profile}`)
          .join('\n')}`,
      ].join('\n\n');
      const r = await llm().json<{ picks: { user_id: number; reason: string; pitch: string }[] }>({
        name: 'rerank',
        system: RERANK_SYSTEM,
        input,
        schema: RERANK_SCHEMA,
      });
      const seen = new Set<number>();
      picks = [];
      for (const p of r?.picks ?? []) {
        const id = Number(p.user_id);
        if (!byId.has(id) || seen.has(id)) continue;
        seen.add(id);
        const fb = fallbackPick(req.purpose, byId.get(id)!);
        picks.push({ userId: id, reason: p.reason?.trim() || fb.reason, pitch: p.pitch?.trim() || fb.pitch });
        if (picks.length >= k) break;
      }
    } catch {
      picks = null;
    }
  }
  const usedLlm = picks !== null;
  if (!picks) {
    picks = [...req.candidates]
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, k)
      .map((c) => fallbackPick(req.purpose, c));
  }

  await trace('rerank', req.refId ?? null, {
    purpose: req.purpose,
    k,
    candidates: req.candidates.length,
    llm: usedLlm,
    picks: picks.map((p) => ({ userId: p.userId, name: byId.get(p.userId)?.name ?? '', reason: p.reason, pitch: p.pitch })),
  });
  return picks;
}

// On-demand people search. `request` narrows it ("someone to hit 4.5 tennis with"); without it, uses the user's own vector.
export async function findPeople(userId: number, request?: string, k?: number): Promise<PersonMatch[]> {
  const user = await getUser(userId);
  if (!user) throw new Error(`no user ${userId}`);
  const ask = request?.trim();
  const vector = ask ? await embedOne(`Looking for: ${ask}`) : user.embedding;
  if (!vector) return [];

  const linked = await q<{ other: number }>(
    `SELECT CASE WHEN requester_id = $1 THEN target_id ELSE requester_id END AS other
     FROM intros WHERE requester_id = $1 OR target_id = $1`,
    [userId],
  );
  const exclude = [userId, ...linked.map((r) => r.other)];
  const candidates = await recall(vector, { exclude, refId: userId, label: ask ? `people: ${ask}` : 'people' });

  const target = [
    ask ? `Looking for: ${ask}` : 'Looking for: people who share their interests',
    `Requester (${firstName(user.name)}) profile:\n${user.canonicalProfile ?? '(none)'}`,
  ].join('\n\n');
  const picks = await rerank({ purpose: 'people', target, candidates, k: k ?? PEOPLE_K, refId: userId });
  const names = new Map(candidates.map((c) => [c.userId, c.name]));
  return picks.map((p) => ({ userId: p.userId, name: firstName(names.get(p.userId)), reason: p.reason }));
}
