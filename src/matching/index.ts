// CONTRACT (stub). Owner: matching subagent. Signatures are fixed; replace bodies.
import type { PersonMatch, RecallHit, RerankPick } from '../types.ts';

export type RecallOpts = { exclude?: number[]; limit?: number; refId?: number | null; label?: string };

// Stage 1: pgvector cosine top-N over active, non-snoozed users with an embedding.
export async function recall(vector: number[], opts?: RecallOpts): Promise<RecallHit[]> {
  throw new Error('not implemented');
}

// Stage 2: LLM picks up to k best candidates for `target` and writes a reason + 1-sentence SMS pitch for each.
// May return fewer than k (drops poor fits). Fallback without LLM: top-k by similarity, template pitch.
export type RerankReq = { purpose: 'event' | 'people'; target: string; candidates: RecallHit[]; k: number; refId?: number | null };
export async function rerank(req: RerankReq): Promise<RerankPick[]> {
  throw new Error('not implemented');
}

// On-demand people search. `request` narrows it ("someone to hit 4.5 tennis with"); without it, uses the user's own vector.
export async function findPeople(userId: number, request?: string, k?: number): Promise<PersonMatch[]> {
  throw new Error('not implemented');
}
