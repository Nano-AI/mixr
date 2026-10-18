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

// Wipes everything (tests only). Children before parents so foreign keys hold. Keeps the embedding cache.
export async function reset(): Promise<void> {
  await (await db()).exec(
    `TRUNCATE traces, jobs, intros, screenings, requirements, blocks, event_invites, message_jobs, inbound_messages,
       email_codes, events, messages, users RESTART IDENTITY CASCADE;
     UPDATE clock SET now = now();`,
  );
}

// The dashboard's Reset: removes the demo pool only (seeded/dashboard users and everything they touched) and
// resets the demo clock. Real users, their conversations and events are never touched.
export async function resetDemo(): Promise<void> {
  await (await db()).exec(
    `DELETE FROM screenings WHERE user_id IN (SELECT id FROM users WHERE seeded)
       OR requirement_id IN (SELECT r.id FROM requirements r JOIN users u ON u.id = r.owner_id WHERE u.seeded);
     DELETE FROM requirements WHERE owner_id IN (SELECT id FROM users WHERE seeded);
     DELETE FROM blocks WHERE blocker_id IN (SELECT id FROM users WHERE seeded);
     DELETE FROM event_invites WHERE user_id IN (SELECT id FROM users WHERE seeded)
       OR event_id IN (SELECT e.id FROM events e JOIN users u ON u.id = e.host_id WHERE u.seeded);
     DELETE FROM intros WHERE requester_id IN (SELECT id FROM users WHERE seeded) OR target_id IN (SELECT id FROM users WHERE seeded);
     DELETE FROM message_jobs WHERE user_id IN (SELECT id FROM users WHERE seeded);
     DELETE FROM email_codes WHERE user_id IN (SELECT id FROM users WHERE seeded);
     DELETE FROM messages WHERE user_id IN (SELECT id FROM users WHERE seeded);
     DELETE FROM events WHERE host_id IN (SELECT id FROM users WHERE seeded);
     DELETE FROM jobs WHERE pool = 'demo';
     DELETE FROM traces WHERE pool = 'demo' AND kind NOT IN ('llm', 'embed');
     DELETE FROM users WHERE seeded;
     UPDATE clock SET now = now();`,
  );
}

// pgvector literal in, number[] out.
export const toVec = (v: number[]): string => `[${v.join(',')}]`;
export const fromVec = (s: string | null): number[] | null => (s ? JSON.parse(s) : null);

const USER_COLS =
  'id, phone, name, state, canonical_profile, embedding::text AS embedding, snoozed_until, seeded, step, email, email_verified, opted_out, assigned_number, joined_via';

export async function getUser(id: number): Promise<User | undefined> {
  const r = await one(`SELECT ${USER_COLS} FROM users WHERE id = $1`, [id]);
  return r && rowToUser(r);
}

export async function getUserByPhone(phone: string): Promise<User | undefined> {
  const r = await one(`SELECT ${USER_COLS} FROM users WHERE phone = $1`, [phone]);
  return r && rowToUser(r);
}

// demo: a number first seen in the dashboard joins the demo pool. Numbers first seen over iMessage or the
// website are real. An existing user keeps their pool.
export async function getOrCreateUser(phone: string, opts: { demo?: boolean } = {}): Promise<User> {
  await q(`INSERT INTO users (phone, seeded, joined_via) VALUES ($1, $2, $3) ON CONFLICT (phone) DO NOTHING`, [
    phone,
    !!opts.demo,
    opts.demo ? 'demo' : 'imessage',
  ]);
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
    step: r.step ?? null,
    email: r.email ?? null,
    emailVerified: !!r.email_verified,
    optedOut: !!r.opted_out,
    assignedNumber: r.assigned_number ?? null,
    joinedVia: r.joined_via ?? null,
  };
}
