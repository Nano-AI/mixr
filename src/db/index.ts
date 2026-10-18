import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { config } from '../config.ts';
import type { User } from '../types.ts';

const SCHEMA = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

// Memoize the promise, not the instance: concurrent first callers must share one PGlite (each is ~600 MB).
let pg: Promise<PGlite> | undefined;

export function db(): Promise<PGlite> {
  pg ??= open();
  return pg;
}

async function open(): Promise<PGlite> {
  if (!config.dbDir.includes('://')) mkdirSync(dirname(config.dbDir), { recursive: true });
  const p = await PGlite.create(config.dbDir, { extensions: { vector } });
  await p.exec(SCHEMA);
  await p.query(`INSERT INTO clock (id, now) VALUES (1, now()) ON CONFLICT (id) DO NOTHING`);
  return p;
}

export async function q<T = Record<string, any>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await (await db()).query<T>(sql, params)).rows;
}

export async function one<T = Record<string, any>>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  return (await q<T>(sql, params))[0];
}

// Children before parents so foreign keys hold. Keeps the embedding cache (it's free money).
export async function reset(): Promise<void> {
  await (await db()).exec(
    `TRUNCATE traces, jobs, intros, screenings, requirements, blocks, event_invites, events, messages, users RESTART IDENTITY CASCADE;
     UPDATE clock SET now = now();`,
  );
}

// pgvector literal in, number[] out.
export const toVec = (v: number[]): string => `[${v.join(',')}]`;
export const fromVec = (s: string | null): number[] | null => (s ? JSON.parse(s) : null);

const USER_COLS = 'id, phone, name, state, canonical_profile, embedding::text AS embedding, snoozed_until, seeded';

export async function getUser(id: number): Promise<User | undefined> {
  const r = await one(`SELECT ${USER_COLS} FROM users WHERE id = $1`, [id]);
  return r && rowToUser(r);
}

export async function getUserByPhone(phone: string): Promise<User | undefined> {
  const r = await one(`SELECT ${USER_COLS} FROM users WHERE phone = $1`, [phone]);
  return r && rowToUser(r);
}

export async function getOrCreateUser(phone: string): Promise<User> {
  await q(`INSERT INTO users (phone) VALUES ($1) ON CONFLICT (phone) DO NOTHING`, [phone]);
  return (await getUserByPhone(phone))!;
}

function rowToUser(r: Record<string, any>): User {
  return {
    id: r.id,
    phone: r.phone,
    name: r.name,
    state: r.state,
    canonicalProfile: r.canonical_profile,
    embedding: fromVec(r.embedding),
    snoozedUntil: r.snoozed_until ? new Date(r.snoozed_until) : null,
    seeded: r.seeded,
  };
}
