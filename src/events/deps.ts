import * as matching from '../matching/index.ts';
import type { RecallOpts, RerankReq } from '../matching/index.ts';
import type { RecallHit, RerankPick } from '../types.ts';

// The two matching stages events depend on. Production always uses the real matching module;
// tests swap in fakes with setMatchingDeps() instead of mocking modules.
export type MatchingDeps = {
  recall: (vector: number[], opts?: RecallOpts) => Promise<RecallHit[]>;
  rerank: (req: RerankReq) => Promise<RerankPick[]>;
};

const real: MatchingDeps = {
  recall: (v, o) => matching.recall(v, o),
  rerank: (r) => matching.rerank(r),
};

let current: MatchingDeps = real;

export const matchingDeps = (): MatchingDeps => current;

// Pass overrides to replace one or both stages; call with no args to restore the real module.
export function setMatchingDeps(d?: Partial<MatchingDeps>): void {
  current = d ? { ...real, ...d } : real;
}
