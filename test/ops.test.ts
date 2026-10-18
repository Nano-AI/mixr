import { test, expect } from 'vitest';
import { fresh, makeUser } from './helpers.ts';
import { q } from '../src/db/index.ts';
import { config } from '../src/config.ts';
import { resetPhotonUsers, resetRealDb } from '../src/ops/resetReal.ts';

test('resetRealDb removes real users and their data, keeps the demo pool', async () => {
  await fresh();
  const demo = await makeUser('Demo Dana', 'tennis');
  const [{ id: real }] = await q<{ id: number }>(`INSERT INTO users (phone, name, seeded) VALUES ('+12065559999', 'Real Riley', false) RETURNING id`);
  await q(`INSERT INTO messages (user_id, direction, text, sim_time) VALUES ($1, 'in', 'hi', now()), ($2, 'in', 'hi', now())`, [real, demo]);
  expect((await resetRealDb()).users).toBe(1);
  expect((await q('SELECT id FROM users')).map((r) => r.id)).toEqual([demo]);
  expect((await q('SELECT user_id FROM messages')).map((r) => r.user_id)).toEqual([demo]);
});

test('resetPhotonUsers deletes every registered user (fake API)', async () => {
  const saved = { id: config.photonProjectId, secret: config.photonProjectSecret };
  config.photonProjectId = 'p1';
  config.photonProjectSecret = 's1';
  const calls: string[] = [];
  const fake = (async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (!init?.method) return new Response(JSON.stringify({ succeed: true, data: { users: [{ id: 'u1', phoneNumber: '+12065550001' }, { id: 'u2', phoneNumber: '+12065550002' }], total: 2 } }));
    return new Response(JSON.stringify({ succeed: true }));
  }) as typeof fetch;
  try {
    expect((await resetPhotonUsers(fake)).deleted).toEqual(['..0001', '..0002']);
    expect(calls).toEqual([
      'GET https://spectrum.photon.codes/projects/p1/users/',
      'DELETE https://spectrum.photon.codes/projects/p1/users/u1/',
      'DELETE https://spectrum.photon.codes/projects/p1/users/u2/',
    ]);
  } finally {
    config.photonProjectId = saved.id;
    config.photonProjectSecret = saved.secret;
  }
});
