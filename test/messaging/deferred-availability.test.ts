import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, reset } from '../../src/db.ts';
import { getState, saveState, moveCompletedProfilesToChat } from '../../src/messaging/state.ts';
import { makeUser } from '../helpers.ts';

test('old compulsory availability step resumes chat; explicit FREE and unverified onboarding stay intact', () => {
  reset();
  const old = makeUser({ slots: ['2099-10-22T19:00:00.000Z'] });
  const explicit = makeUser(); const unverified = makeUser(); const unfinished = makeUser();
  db.prepare("UPDATE users SET step='availability',email_verified=1").run();
  db.prepare('UPDATE users SET email_verified=0 WHERE id=?').run(unverified);
  db.prepare('UPDATE profiles SET confirmed=0 WHERE user_id=?').run(unfinished);
  saveState(old, { draft: 'Chess', slots: ['2099-10-22T19:00:00.000Z'] });
  saveState(explicit, { onboarded: true });
  assert.equal(moveCompletedProfilesToChat(), 1);
  assert.equal(db.prepare('SELECT step FROM users WHERE id=?').get(old)!.step, 'active');
  assert.equal(getState(old).onboarded, true);
  assert.equal(getState(old).draft, 'Chess');
  assert.equal(db.prepare('SELECT count(*) n FROM availability WHERE user_id=?').get(old)!.n, 1);
  for (const id of [explicit, unverified, unfinished])
    assert.equal(db.prepare('SELECT step FROM users WHERE id=?').get(id)!.step, 'availability');
  assert.equal(moveCompletedProfilesToChat(), 0);
});
