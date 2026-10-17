import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

const SCHEMA = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

// schema.sql is CREATE IF NOT EXISTS, so columns added later need an ALTER on older databases.
export function migrate(d: DatabaseSync): void {
  d.exec(SCHEMA);
  const cols = d.prepare('PRAGMA table_info(invitations)').all() as { name: string }[];
  if (!cols.some((c) => c.name === 'place_suggestion')) d.exec('ALTER TABLE invitations ADD COLUMN place_suggestion TEXT');
}

export const db = new DatabaseSync(process.env.DB_PATH ?? 'mixr.db');
db.exec('PRAGMA foreign_keys = ON');
migrate(db);

export function tx<T>(fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export const toBlob = (v: Float32Array): Uint8Array => new Uint8Array(v.buffer, v.byteOffset, v.byteLength);

// slice() copies into a fresh, 4-byte-aligned buffer; SQLite's blob may not be aligned.
export const fromBlob = (b: Uint8Array): Float32Array => new Float32Array(b.slice().buffer);

// Children before parents so foreign keys hold. Tests only.
export function reset(): void {
  for (const t of ['feedback', 'invitations', 'message_jobs', 'inbound_messages', 'availability', 'interests', 'profiles', 'meetups', 'users']) {
    db.exec(`DELETE FROM ${t}`);
  }
}
