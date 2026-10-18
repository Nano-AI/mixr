// Lexical side of hybrid recall: BM25 over the candidate set, then reciprocal rank fusion with the vector ranking.
// Catches exact terms embeddings blur ("332", "4.5", "cse").

const STOP = new Set('a an and are as at be but by for from i im in is it its me my of on or so that the this to was with you'.split(' '));

// Lowercase alphanumeric runs; a dot survives only between digits ("4.0"), so "tennis." -> "tennis".
export const tokenize = (text: string): string[] => (text.toLowerCase().match(/[a-z0-9]+(?:\.[0-9]+)*/g) ?? []).filter((w) => !STOP.has(w));

const K1 = 1.2; // tune: term-frequency saturation
const B = 0.75; // tune: length normalization

// BM25 score of each doc for `query`. Document frequencies come from `docs` itself (the candidate set).
export function bm25(query: string, docs: string[]): number[] {
  const terms = [...new Set(tokenize(query))];
  const toks = docs.map(tokenize);
  const N = docs.length;
  const avg = toks.reduce((s, t) => s + t.length, 0) / (N || 1) || 1;
  const tfs = toks.map((t) => t.reduce((m, w) => m.set(w, (m.get(w) ?? 0) + 1), new Map<string, number>()));
  const idf = new Map(terms.map((w) => {
    const n = tfs.filter((m) => m.has(w)).length;
    return [w, Math.log(1 + (N - n + 0.5) / (n + 0.5))];
  }));
  return tfs.map((m, i) =>
    terms.reduce((s, w) => {
      const f = m.get(w) ?? 0;
      return f ? s + (idf.get(w)! * f * (K1 + 1)) / (f + K1 * (1 - B + (B * toks[i].length) / avg)) : s;
    }, 0),
  );
}

const RRF_K = 60; // tune: standard RRF damping

// Reciprocal rank fusion: score(id) = sum over rankings of 1 / (60 + rank), rank 1-based. An id absent from a
// ranking gets no term from it. Ties keep first-seen order (pass the primary ranking first).
export function rrf(...rankings: number[][]): number[] {
  const score = new Map<number, number>();
  for (const ids of rankings) ids.forEach((id, i) => score.set(id, (score.get(id) ?? 0) + 1 / (RRF_K + i + 1)));
  return [...score.keys()].sort((a, b) => score.get(b)! - score.get(a)!);
}
