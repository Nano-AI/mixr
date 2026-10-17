import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

export const db = new DatabaseSync(process.env.DB_PATH ?? 'mixr.db');
db.exec('PRAGMA foreign_keys = ON');
db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));

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
