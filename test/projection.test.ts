import { test, expect } from 'vitest';
import { fresh, makeUser, axis } from './helpers.ts';
import { q, toVec } from '../src/db/index.ts';
import { projection } from '../src/projection.ts';
import { seed } from '../src/seed.ts';
import { T0 } from './helpers.ts';

const finite = (pts: { x: number; y: number }[]) => pts.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y));

async function makeEvent(title: string, e0: number[], et: number[], status = 'open'): Promise<number> {
  const r = await q<{ id: number }>(
    `INSERT INTO events (host_id, title, raw_description, starts_at, location, capacity, hyde_profile, initial_embedding, current_embedding, status, created_at)
     VALUES ((SELECT min(id) FROM users), $1, $1, $2, 'HUB', 4, $1, $3, $4, $5, $2) RETURNING id`,
    [title, T0, toVec(e0), toVec(et), status],
  );
  return r[0].id;
}

test('empty, one and two users: no NaN', async () => {
  await fresh();
  expect((await projection()).points).toEqual([]);
  await makeUser('Solo', 'tennis');
  let pts = (await projection()).points;
  expect(pts).toHaveLength(1);
  expect(finite(pts)).toBe(true);
  await makeUser('Duo', 'baking');
  await makeEvent('Bake off', axis(3), axis(4));
  pts = (await projection()).points;
  expect(pts).toHaveLength(4);
  expect(finite(pts)).toBe(true);
  const [a, b] = pts;
  expect(Math.abs(a.x - b.x)).toBeGreaterThan(1);
});

test('seeded population: finite coords within [-1, 1], identical profiles coincide, events included', async () => {
  await fresh();
  await seed();
  const p = 'Core Interests:\n[1] Competitive tennis, USTA 4.5, tournament sets (Level: Advanced).';
  const a = await makeUser('Twin A', p);
  const b = await makeUser('Twin B', p);
  const ev = await makeEvent('Tennis ladder', axis(1), axis(2));
  await makeEvent('Cancelled thing', axis(5), axis(6), 'cancelled');
  const { points } = await projection();
  expect(points.filter((x) => x.kind === 'user')).toHaveLength(47);
  expect(points.map((x) => x.id)).toEqual(expect.arrayContaining([`e${ev}:0`, `e${ev}:t`]));
  expect(points.filter((x) => x.kind !== 'user')).toHaveLength(2);
  expect(points.find((x) => x.id === `e${ev}:0`)).toMatchObject({ kind: 'event0', eventId: ev, label: 'Tennis ladder' });
  expect(finite(points)).toBe(true);
  for (const pt of points) {
    expect(Math.abs(pt.x)).toBeLessThanOrEqual(1 + 1e-9);
    expect(Math.abs(pt.y)).toBeLessThanOrEqual(1 + 1e-9);
  }
  const pa = points.find((x) => x.id === `u${a}`)!;
  const pb = points.find((x) => x.id === `u${b}`)!;
  expect(pa.label).toBe('Twin A');
  expect(pa.x).toBeCloseTo(pb.x, 9);
  expect(pa.y).toBeCloseTo(pb.y, 9);
});

test('two distinct clusters separate on the first axis', async () => {
  await fresh();
  const tennis = ['singles', 'doubles', 'serve', 'volley', 'ladder'].map((w) => `competitive tennis match play hitting partner ${w}`);
  const baking = ['croissant', 'baguette', 'cookies', 'pastry', 'cake'].map((w) => `sourdough bread baking starter loaves ${w}`);
  const t = await Promise.all(tennis.map((p, i) => makeUser(`T${i}`, p)));
  const k = await Promise.all(baking.map((p, i) => makeUser(`B${i}`, p)));
  const { points } = await projection();
  const xs = (ids: number[]) => ids.map((id) => points.find((p) => p.id === `u${id}`)!.x);
  const tx = xs(t);
  const bx = xs(k);
  const sign = Math.sign(tx[0]);
  expect(sign).not.toBe(0);
  for (const x of tx) expect(Math.sign(x)).toBe(sign);
  for (const x of bx) expect(Math.sign(x)).toBe(-sign);
  expect(Math.min(...tx.map(Math.abs))).toBeGreaterThan(0.5);
});
