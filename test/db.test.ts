import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, tx, toBlob, fromBlob, reset } from '../src/db.ts';
import { makeUser, axis, blend } from './helpers.ts';

test('makeUser returns an id and stores a readable embedding', () => {
  reset();
  const v = blend(axis(0), axis(1), 0.3);
  const id = makeUser({ interests: [{ label: 'chess', vector: v }], slots: ['2026-10-20T12:00:00'] });
  assert.ok(id > 0);
  const row = db.prepare('SELECT embedding FROM interests WHERE user_id = ?').get(id)!;
  assert.deepEqual(fromBlob(row.embedding as Uint8Array), v);
});

test('message_jobs dedupe_key is unique', () => {
  reset();
  const u = makeUser();
  const ins = db.prepare("INSERT INTO message_jobs (user_id, dedupe_key, text) VALUES (?, 'k', 'hi')");
  ins.run(u);
  assert.throws(() => ins.run(u));
});

test('fromBlob(toBlob(v)) round-trips', () => {
  const v = new Float32Array([0.1, -2, 3.5]);
  assert.deepEqual(fromBlob(toBlob(v)), v);
});

test('tx rolls back when fn throws', () => {
  reset();
  assert.throws(() => tx(() => { makeUser(); throw new Error('boom'); }), /boom/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM users').get()!.n, 0);
});
