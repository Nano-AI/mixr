import { test, expect, describe } from 'vitest';
import { fresh, makeUser, axis, T0 } from './helpers.ts';
import { recall, rerank, findPeople, topInterest } from '../src/matching/index.ts';
import { getOrCreateUser, q } from '../src/db/index.ts';
import { normalize, add } from '../src/vec.ts';
import { requestIntro } from '../src/relay/index.ts';
import type { RecallHit } from '../src/types.ts';
import type { JsonRequest } from '../src/llm/index.ts';

const mix = (...vs: number[][]) => normalize(add(...vs));
const hit = (userId: number, similarity: number, profile = 'Core Interests:\n[1] Thing.'): RecallHit => ({ userId, name: `U${userId}`, profile, similarity });

describe('recall', () => {
  test('orders by cosine and reports similarity', async () => {
    await fresh();
    const c = await makeUser('C', 'c', axis(1));
    const a = await makeUser('A', 'a', axis(0));
    const b = await makeUser('B', 'b', mix(axis(0), axis(1)));
    const hits = await recall(axis(0));
    expect(hits.map((h) => h.userId)).toEqual([a, b, c]);
    expect(hits[0].similarity).toBeCloseTo(1, 5);
    expect(hits[1].similarity).toBeCloseTo(Math.SQRT1_2, 5);
    expect(hits[2].similarity).toBeCloseTo(0, 5);
    expect(hits[0]).toMatchObject({ name: 'A', profile: 'a' });
  });

  test('excludes snoozed (until future), onboarding, null embeddings and excluded ids; respects limit', async () => {
    await fresh();
    const a = await makeUser('A', 'a', axis(0));
    const b = await makeUser('B', 'b', axis(0));
    const snoozed = await makeUser('S', 's', axis(0));
    const wokeUp = await makeUser('W', 'w', axis(0));
    const onboarding = await makeUser('O', 'o', axis(0));
    const noVec = await makeUser('N', 'n', axis(0));
    await q(`UPDATE users SET snoozed_until = $2 WHERE id = $1`, [snoozed, new Date(T0.getTime() + 3600_000).toISOString()]);
    await q(`UPDATE users SET snoozed_until = $2 WHERE id = $1`, [wokeUp, new Date(T0.getTime() - 3600_000).toISOString()]);
    await q(`UPDATE users SET state = 'onboarding' WHERE id = $1`, [onboarding]);
    await q(`UPDATE users SET embedding = NULL WHERE id = $1`, [noVec]);
    await getOrCreateUser('+10000000000'); // brand-new onboarding user, no embedding

    const ids = (await recall(axis(0), { exclude: [b] })).map((h) => h.userId).sort();
    expect(ids).toEqual([a, wokeUp].sort());
    expect(await recall(axis(0), { limit: 1 })).toHaveLength(1);
  });

  test('trace keeps names and rounded similarities, never vectors', async () => {
    await fresh();
    await makeUser('A', 'a', mix(axis(0), axis(1), axis(2)));
    await recall(axis(0), { refId: 7, label: 'test' });
    const [t] = await q<{ ref_id: number; data: any }>(`SELECT ref_id, data FROM traces WHERE kind = 'recall'`);
    expect(t.ref_id).toBe(7);
    expect(t.data.label).toBe('test');
    expect(t.data.hits[0].similarity).toBe(0.577);
    expect(JSON.stringify(t.data).length).toBeLessThan(500);
  });
});

describe('rerank', () => {
  test('fallback: top k by similarity with template pitch from first slot', async () => {
    await fresh();
    const cands = [
      hit(1, 0.2),
      hit(2, 0.9, 'Core Interests:\n[1] Competitive tennis, varsity match play, USTA 4.5 (Level: Advanced).\n[2] Jazz.'),
      hit(3, 0.5),
    ];
    const picks = await rerank({ purpose: 'event', target: 't', candidates: cands, k: 2 });
    expect(picks.map((p) => p.userId)).toEqual([2, 3]);
    expect(picks[0].pitch).toBe("thought of you since you're into competitive tennis, varsity match play, USTA 4.5.");
    expect(picks[0].pitch).not.toMatch(/score|vector|algorithm|wave|similar/i);
  });

  test('LLM: drops unknown + duplicate ids, caps at k, keeps LLM order', async () => {
    const fake = await fresh();
    let req: JsonRequest | undefined;
    fake.onJson('rerank', (r) => {
      req = r;
      return {
        picks: [
          { user_id: 3, reason: 'r3', pitch: 'p3' },
          { user_id: 99, reason: 'nope', pitch: 'nope' },
          { user_id: 3, reason: 'dup', pitch: 'dup' },
          { user_id: 1, reason: 'r1', pitch: 'p1' },
          { user_id: 2, reason: 'r2', pitch: 'p2' },
        ],
      };
    });
    const picks = await rerank({ purpose: 'people', target: 'tennis partner', candidates: [hit(1, 0.9), hit(2, 0.8), hit(3, 0.1)], k: 2, refId: 5 });
    expect(picks).toEqual([
      { userId: 3, reason: 'r3', pitch: 'p3' },
      { userId: 1, reason: 'r1', pitch: 'p1' },
    ]);
    expect(req!.input).toContain('PURPOSE: people');
    expect(req!.input).toContain('tennis partner');
    expect(req!.input).toContain('user_id: 3');
    const s: any = req!.schema;
    expect(s.additionalProperties).toBe(false);
    expect(s.properties.picks.items.required).toEqual(['user_id', 'reason', 'pitch', 'checks']);
    const [t] = await q<{ ref_id: number; data: any }>(`SELECT ref_id, data FROM traces WHERE kind = 'rerank'`);
    expect(t.ref_id).toBe(5);
    expect(t.data.picks.map((p: any) => p.reason)).toEqual(['r3', 'r1']);
  });

  test('LLM may return fewer (or none)', async () => {
    const fake = await fresh();
    fake.onJson('rerank', () => ({ picks: [] }));
    expect(await rerank({ purpose: 'event', target: 't', candidates: [hit(1, 0.9)], k: 3 })).toEqual([]);
  });

  test('LLM error falls back to similarity order', async () => {
    const fake = await fresh();
    fake.onJson('rerank', () => {
      throw new Error('rate limited');
    });
    const picks = await rerank({ purpose: 'event', target: 't', candidates: [hit(1, 0.1), hit(2, 0.9)], k: 5 });
    expect(picks.map((p) => p.userId)).toEqual([2, 1]);
  });

  test('empty candidates or k=0 returns nothing', async () => {
    await fresh();
    expect(await rerank({ purpose: 'event', target: 't', candidates: [], k: 3 })).toEqual([]);
    expect(await rerank({ purpose: 'event', target: 't', candidates: [hit(1, 1)], k: 0 })).toEqual([]);
  });

  test('topInterest strips tags and handles non-canonical text', () => {
    expect(topInterest('Core Interests:\n[1] Jazz piano, bebop (Vibe: Chill).')).toBe('jazz piano, bebop');
    expect(topInterest('i like hiking')).toBe('i like hiking');
  });
});

describe('findPeople', () => {
  test("uses own vector, excludes self and anyone already in an intro (either direction); first names", async () => {
    await fresh();
    const me = await makeUser('Maya Lopez', 'me', axis(0));
    const asked = await makeUser('Asked', 'x', axis(0));
    const askedMe = await makeUser('AskedMe', 'x', axis(0));
    const close = await makeUser('Jordan Lee', 'Core Interests:\n[1] Tennis doubles.', mix(axis(0), axis(1)));
    const far = await makeUser('Far', 'x', axis(2));
    await requestIntro(me, asked, 'tennis');
    await requestIntro(askedMe, me, 'tennis');
    const res = await findPeople(me, undefined, 2);
    expect(res.map((r) => r.userId)).toEqual([close, far]);
    expect(res[0].name).toBe('Jordan');
    expect(res[0].reason).toContain('tennis doubles');
  });

  test('request text drives the query vector and LLM rerank purpose=people', async () => {
    const fake = await fresh();
    let input = '';
    fake.onJson('rerank', (r) => {
      input = r.input;
      const ids = [...r.input.matchAll(/user_id: (\d+)/g)].map((m) => Number(m[1]));
      return { picks: ids.slice(0, 1).map((id) => ({ user_id: id, reason: 'you both love sourdough', pitch: 'p' })) };
    });
    const me = await makeUser('Me', 'Core Interests:\n[1] Competitive tennis.');
    const baker = await makeUser('Bea', 'Looking for: sourdough baking bread');
    await makeUser('Tim', 'Competitive tennis.');
    const res = await findPeople(me, 'sourdough baking bread');
    expect(res).toEqual([{ userId: baker, name: 'Bea', reason: 'you both love sourdough' }]);
    expect(input).toContain('PURPOSE: people');
    expect(input).toContain('Looking for: sourdough baking bread');
  });
});
