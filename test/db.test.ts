import { test, expect } from 'vitest';
import { db } from '../src/db/index.ts';

test('concurrent first calls share one PGlite instance', async () => {
  const all = await Promise.all(Array.from({ length: 10 }, () => db()));
  expect(new Set(all).size).toBe(1);
});
