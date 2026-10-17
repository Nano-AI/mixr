import { readFileSync } from 'node:fs';
import { q, toVec } from './db/index.ts';
import { embed } from './llm/embed.ts';

export type SeedUser = { name: string; phone: string; profile: string };

const FIXTURE = new URL('../fixtures/seed-users.json', import.meta.url);

export function loadSeedUsers(): SeedUser[] {
  return JSON.parse(readFileSync(FIXTURE, 'utf8')) as SeedUser[];
}

// Upserts every fixture user by phone as an active, seeded user. Idempotent; the only external call is
// one batched embed() (real API is cached by text, so re-seeding is free).
export async function seed(): Promise<number> {
  const users = loadSeedUsers();
  const vectors = await embed(users.map((u) => u.profile));
  for (const [i, u] of users.entries()) {
    await q(
      `INSERT INTO users (phone, name, state, canonical_profile, embedding, seeded)
       VALUES ($1, $2, 'active', $3, $4, true)
       ON CONFLICT (phone) DO UPDATE SET name = EXCLUDED.name, state = 'active',
         canonical_profile = EXCLUDED.canonical_profile, embedding = EXCLUDED.embedding, seeded = true`,
      [u.phone, u.name, u.profile, toVec(vectors[i])],
    );
  }
  return users.length;
}
