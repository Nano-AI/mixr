import { test, expect } from 'vitest';
import { fresh, makeUser, T0 } from './helpers.ts';
import { now } from '../src/clock.ts';
import { advance, registerJob, schedule } from '../src/jobs/index.ts';
import { fakeEmbed } from '../src/llm/embed.ts';
import { cosine } from '../src/vec.ts';
import { getUser } from '../src/db/index.ts';
import { HOUR } from '../src/clock.ts';

test('fake embeddings: shared words are closer than unrelated text', async () => {
  const [a, b, c] = await fakeEmbed(['competitive tennis hitting partner', 'tennis doubles match', 'sourdough baking bread']);
  expect(cosine(a, b)).toBeGreaterThan(cosine(a, c));
});

test('user round-trips its embedding', async () => {
  await fresh();
  const id = await makeUser('Maya', 'tennis');
  const u = await getUser(id);
  expect(u!.embedding).toHaveLength(1536);
});

test('advance runs due jobs in time order and lands on the target', async () => {
  await fresh();
  const seen: string[] = [];
  registerJob('expire_intro', async (p) => void seen.push(`${p.n}@${(await now()).toISOString()}`));
  await schedule('expire_intro', { n: 2 }, new Date(T0.getTime() + 2 * HOUR));
  await schedule('expire_intro', { n: 1 }, new Date(T0.getTime() + 1 * HOUR));
  await schedule('expire_intro', { n: 3 }, new Date(T0.getTime() + 5 * HOUR));
  expect(await advance(3 * HOUR)).toBe(2);
  expect(seen.map((s) => s.split('@')[0])).toEqual(['1', '2']);
  expect((await now()).getTime()).toBe(T0.getTime() + 3 * HOUR);
});
