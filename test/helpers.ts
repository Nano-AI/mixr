import { reset, q, toVec } from '../src/db/index.ts';
import { setNow } from '../src/clock.ts';
import { FakeLlm, setLlm } from '../src/llm/index.ts';
import { fakeEmbed } from '../src/llm/embed.ts';

export const T0 = new Date('2026-10-20T12:00:00-07:00');

// Fresh DB, clock at T0, fresh fake LLM (no handlers = every pipeline step uses its fallback).
export async function fresh(): Promise<FakeLlm> {
  await reset();
  await setNow(T0);
  const fake = new FakeLlm();
  setLlm(fake);
  return fake;
}

// Active user whose embedding is fakeEmbed(profile) unless a vector is given.
export async function makeUser(name: string, profile: string, vector?: number[]): Promise<number> {
  const v = vector ?? (await fakeEmbed([profile]))[0];
  const phone = `+1555${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
  const r = await q<{ id: number }>(
    // Demo pool: tests run without a context, which is the demo pool (simulated clock, no delivery).
    `INSERT INTO users (phone, name, state, canonical_profile, embedding, seeded) VALUES ($1, $2, 'active', $3, $4, true) RETURNING id`,
    [phone, name, profile, toVec(v)],
  );
  return r[0].id;
}

// Unit vector along axis i.
export const axis = (i: number, dims = 1536): number[] => Array.from({ length: dims }, (_, j) => (j === i ? 1 : 0));
