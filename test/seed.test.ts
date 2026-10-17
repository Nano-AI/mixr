import { test, expect } from 'vitest';
import { fresh } from './helpers.ts';
import { q } from '../src/db/index.ts';
import { loadSeedUsers, seed } from '../src/seed.ts';
import { getUserByPhone } from '../src/db/index.ts';

const TAG = /\((Level: (Beginner|Intermediate|Advanced)|Vibe: (Casual|Social|Competitive|Chill))\)\.?$/;

test('fixture: 45 users, unique sequential phones, canonical profiles', () => {
  const users = loadSeedUsers();
  expect(users).toHaveLength(45);
  expect(new Set(users.map((u) => u.phone)).size).toBe(45);
  expect(new Set(users.map((u) => u.name)).size).toBe(45);
  users.forEach((u, i) => expect(u.phone).toBe(`+120655501${String(i + 1).padStart(2, '0')}`));
  for (const u of users) {
    const lines = u.profile.split('\n');
    expect(lines[0], u.name).toBe('Core Interests:');
    const slots = lines.slice(1);
    expect(slots.length, u.name).toBeGreaterThanOrEqual(2);
    expect(slots.length, u.name).toBeLessThanOrEqual(6);
    slots.forEach((s, i) => {
      expect(s.startsWith(`[${i + 1}] `), `${u.name}: ${s}`).toBe(true);
      expect(s, u.name).toMatch(TAG);
    });
  }
});

test('seed loads 45 active seeded users with 1536-d embeddings and is idempotent', async () => {
  await fresh();
  expect(await seed()).toBe(45);
  expect(await seed()).toBe(45);
  const [{ n }] = await q<{ n: number }>(
    `SELECT count(*)::int AS n FROM users WHERE state = 'active' AND seeded AND embedding IS NOT NULL AND name IS NOT NULL`,
  );
  expect(n).toBe(45);
  const [{ total }] = await q<{ total: number }>(`SELECT count(*)::int AS total FROM users`);
  expect(total).toBe(45);
  const maya = await getUserByPhone('+12065550101');
  expect(maya!.name).toBe('Maya Chen');
  expect(maya!.embedding).toHaveLength(1536);
  expect(maya!.canonicalProfile).toMatch(/^Core Interests:\n\[1\]/);
});

test('seed upgrades an existing onboarding user with the same phone', async () => {
  await fresh();
  await q(`INSERT INTO users (phone) VALUES ('+12065550101')`);
  await seed();
  const maya = await getUserByPhone('+12065550101');
  expect(maya!.state).toBe('active');
  expect(maya!.seeded).toBe(true);
});
