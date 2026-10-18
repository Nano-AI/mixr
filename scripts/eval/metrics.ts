// Pure scoring helpers for the eval harness. Self-check: node --import tsx scripts/eval/metrics.ts
import assert from 'node:assert/strict';

// Fraction of the expected items found in the first k of the ranking.
export function recallAt(ranked: string[], expected: string[], k: number): number {
  if (!expected.length) return 0;
  const top = new Set(ranked.slice(0, k));
  return expected.filter((e) => top.has(e)).length / expected.length;
}

// 1 / rank of the first expected item (0 when none is ranked).
export function mrr(ranked: string[], expected: string[]): number {
  const want = new Set(expected);
  const i = ranked.findIndex((r) => want.has(r));
  return i < 0 ? 0 : 1 / (i + 1);
}

// Share of the returned picks that are expected (the reranker may return fewer than k on purpose).
export function precision(picks: string[], expected: string[]): number {
  if (!picks.length) return 0;
  const want = new Set(expected);
  return picks.filter((p) => want.has(p)).length / picks.length;
}

export const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

// Nearest-rank p90.
export function p90(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(0.9 * s.length) - 1)];
}

const STOP = new Set(
  'the and for are you but not got can that this with have from your just like really also into what when want about some them they their there been were will would could should more much very than then love enjoy into'.split(' '),
);
export const contentWords = (text: string): Set<string> =>
  new Set((text.toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? []).filter((w) => !STOP.has(w)));

// ponytail: word-overlap heuristic. A reply "restates the profile" when it repeats >= RESTATE_WORDS distinct content
// words the user already said. Misses paraphrases; swap for an LLM judge if this gets noisy.
export const RESTATE_WORDS = 5;
export function restates(reply: string, userSaid: string[]): boolean {
  const said = contentWords(userSaid.join(' '));
  let n = 0;
  for (const w of contentWords(reply)) if (said.has(w)) n++;
  return n >= RESTATE_WORDS;
}

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

// Bubbles that exactly repeat an earlier bubble (in this turn or earlier ones in the conversation).
export function duplicates(bubbles: string[], earlier: string[] = []): number {
  const seen = new Set(earlier.map(norm));
  let n = 0;
  for (const b of bubbles) {
    const k = norm(b);
    if (seen.has(k)) n++;
    seen.add(k);
  }
  return n;
}

// Narration: sentences about what mixr did or will do ("i'll get back to you", "i'll leave X out"). Some are fine
// ("i'll text you when something fits"), so compare the rate across revisions rather than aiming for zero.
const NARRATION = /\b(i'?ll|i will|i'?ve|i just|i'?m going to|let me)\b|as soon as|get back to you|keep you posted|you two can|sort out the details|leave .* out/i;
export const narration = (t: string): number => t.split(/(?<=[.!?])\s+/).filter((x) => NARRATION.test(x)).length;

// Tapbacks: a reaction is logged as a bubble that is just the emoji (mirrors TAPBACKS in src/transport/outbox.ts).
const TAPBACKS = new Set(['❤️', '👍', '😂', '‼️']);
export const reactions = (bubbles: string[]): number => bubbles.filter((b) => TAPBACKS.has(b.trim())).length;
// A turn answered with a tapback and no text.
export const reactOnly = (bubbles: string[]): boolean => bubbles.length > 0 && reactions(bubbles) === bubbles.length;

export type ReplyStats = { chars: number; bubbles: number; questions: number; capital: boolean; restates: boolean; dupes: number; narration: number; reactions: number; reactOnly: boolean };

export function replyStats(bubbles: string[], userSaid: string[], earlier: string[]): ReplyStats {
  const text = bubbles.join('\n');
  return {
    chars: text.length,
    bubbles: bubbles.length,
    questions: (text.match(/\?/g) ?? []).length,
    capital: /^[A-Z]/.test(bubbles[0]?.trim() ?? ''),
    restates: restates(text, userSaid),
    dupes: duplicates(bubbles, earlier),
    narration: narration(text),
    reactions: reactions(bubbles),
    reactOnly: reactOnly(bubbles),
  };
}

if (import.meta.main) {
  assert.equal(narration("asked Casey. i'll leave the trash talk out. i'll get back to you when she answers."), 2);
  assert.equal(narration('bet, casey plays league ranked. want me to ask?'), 0);
  assert.equal(recallAt(['a', 'b', 'c'], ['c', 'z'], 2), 0);
  assert.equal(recallAt(['a', 'b', 'c'], ['c', 'z'], 3), 0.5);
  assert.equal(mrr(['a', 'b', 'c'], ['c']), 1 / 3);
  assert.equal(mrr(['a'], ['z']), 0);
  assert.equal(precision(['a', 'b'], ['a']), 0.5);
  assert.equal(precision([], ['a']), 0);
  assert.equal(p90([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 9);
  assert.equal(p90([5]), 5);
  assert.equal(duplicates(['hi', 'Hi ', 'yo'], ['yo']), 2);
  assert.ok(restates('got it: photography, programming, chess, poker, gym', ['I love photography, programming, chess, poker and the gym']));
  assert.ok(!restates('nice! anyone in mind?', ['I love photography, programming, chess, poker and the gym']));
  const s = replyStats(['Hey there? ok?', 'second'], [], []);
  assert.deepEqual([s.bubbles, s.questions, s.capital, s.dupes, s.reactions, s.reactOnly], [2, 2, true, 0, 0, false]);
  assert.equal(reactions(['❤️', 'see you there!']), 1);
  assert.ok(reactOnly(['👍']));
  assert.ok(!reactOnly(['❤️', 'see you there!']));
  assert.ok(!reactOnly([]));
  assert.equal(reactions(['nice ❤️']), 0);
  console.log('metrics self-check ok');
}
