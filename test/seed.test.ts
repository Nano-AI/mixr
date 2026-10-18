import { test, expect } from 'vitest';
import { fresh } from './helpers.ts';
import { q } from '../src/db/index.ts';
import { loadSeedUsers, seed } from '../src/seed.ts';
import { getUserByPhone } from '../src/db/index.ts';
import { now } from '../src/clock.ts';

const N = 50;
const TAG = /\((Level: (Beginner|Intermediate|Advanced)|Vibe: (Casual|Social|Competitive|Chill))\)\.?$/;
// Internal mechanics and things that don't exist for a freshly seeded user.
const BANNED = /\b(wave[sd]?|vectors?|scor(e|es|ed|ing)|algorithms?|embeddings?|invit(e|es|ed|ing|ations?)|intros?|introductions?)\b/i;
const EMOJI = /\p{Extended_Pictographic}/gu;
const DAY = 24 * 3600_000;

type Row = { direction: 'in' | 'out'; text: string; sim_time: string };
const messagesFor = (phone: string) =>
  q<Row>(`SELECT m.direction, m.text, m.sim_time FROM messages m JOIN users u ON u.id = m.user_id WHERE u.phone = $1 ORDER BY m.id`, [phone]);

test(`fixture: ${N} users, unique sequential phones, canonical profiles`, () => {
  const users = loadSeedUsers();
  expect(users).toHaveLength(N);
  expect(new Set(users.map((u) => u.phone)).size).toBe(N);
  expect(new Set(users.map((u) => u.name)).size).toBe(N);
  users.forEach((u, i) => expect(u.phone).toBe(`+120655501${String(i + 1).padStart(2, '0')}`));
  for (const u of users) {
    const lines = u.profile.split('\n');
    expect(lines[0], u.name).toBe('Core Interests:');
    const slots = lines.slice(1);
    expect(slots.length, u.name).toBeGreaterThanOrEqual(2);
    expect(slots.length, u.name).toBeLessThanOrEqual(6);
    slots.forEach((s, i) => {
      expect(s.startsWith(`[${i + 1}] `), `${u.name}: ${s}`).toBe(true);
      expect(s, u.name).toMatch(TAG);
    });
  }
});

test('fixture: every user has a plausible onboarding conversation', () => {
  const users = loadSeedUsers();
  for (const u of users) {
    const h = u.history;
    expect(Number.isInteger(u.onboardedDaysAgo) && u.onboardedDaysAgo >= 1 && u.onboardedDaysAgo <= 21, u.name).toBe(true);
    expect(h.length, u.name).toBeGreaterThanOrEqual(3);
    expect(h.length, u.name).toBeLessThanOrEqual(12);
    expect(h[0].from, u.name).toBe('user');
    expect(h.some((m) => m.from === 'mixr'), u.name).toBe(true);
    let run = 0;
    h.forEach((m, i) => {
      expect(['user', 'mixr'], u.name).toContain(m.from);
      expect(m.text.trim().length > 0 && m.text === m.text.trim(), `${u.name} #${i}`).toBe(true);
      expect(m.text, u.name).not.toMatch(BANNED);
      run = i > 0 && h[i - 1].from === m.from ? run + 1 : 1;
      if (m.from === 'mixr') {
        // mixr never double-texts, keeps it SMS-sized and plain: no markdown, <= 1 emoji, <= 1 question
        expect(run, `${u.name}: mixr double text at #${i}`).toBe(1);
        expect(m.text.length, u.name).toBeLessThanOrEqual(320);
        expect(m.text, u.name).not.toMatch(/[*#\n]|^\s*(-|\d+[.)])\s/);
        expect((m.text.match(EMOJI) ?? []).length, m.text).toBeLessThanOrEqual(1);
        expect((m.text.match(/\?/g) ?? []).length, m.text).toBeLessThanOrEqual(1);
        expect(m.text, m.text).not.toMatch(/\bevents?\b/i);
      } else {
        expect(run, `${u.name}: more than 3 texts in a row at #${i}`).toBeLessThanOrEqual(3);
      }
      if (m.gapHours !== undefined) {
        // a later exchange: the user comes back with an update and mixr answers it
        expect(m.from, u.name).toBe('user');
        expect(m.gapHours, u.name).toBeGreaterThan(0);
        expect(h[i + 1]?.from, `${u.name}: later exchange gets a reply`).toBe('mixr');
      }
    });
    // ends with mixr, or with a user's closing text right after mixr ("bet", "ty!!")
    const last = h.length - 1;
    expect(h[last].from === 'mixr' || h[last - 1].from === 'mixr', `${u.name} ends unanswered`).toBe(true);
    // the whole timeline (incl. later exchanges) fits before now
    const gaps = h.reduce((s, m) => s + (m.gapHours ?? 0), 0);
    expect(gaps + 2, u.name).toBeLessThan(u.onboardedDaysAgo * 24);
  }
  expect(new Set(users.map((u) => u.onboardedDaysAgo)).size).toBeGreaterThan(10);
  expect(users.filter((u) => u.history.some((m) => m.gapHours)).length).toBeGreaterThanOrEqual(6);
});

test(`seed loads ${N} active seeded users with 1536-d embeddings and is idempotent`, async () => {
  await fresh();
  expect(await seed()).toBe(N);
  const totalMsgs = loadSeedUsers().reduce((s, u) => s + u.history.length, 0);
  const count = async () => (await q<{ n: number }>(`SELECT count(*)::int AS n FROM messages`))[0].n;
  expect(await count()).toBe(totalMsgs);
  expect(await seed()).toBe(N);
  expect(await count()).toBe(totalMsgs); // re-seed doesn't duplicate history
  const [{ n }] = await q<{ n: number }>(
    `SELECT count(*)::int AS n FROM users WHERE state = 'active' AND seeded AND embedding IS NOT NULL AND name IS NOT NULL`,
  );
  expect(n).toBe(N);
  const [{ total }] = await q<{ total: number }>(`SELECT count(*)::int AS total FROM users`);
  expect(total).toBe(N);
  const maya = await getUserByPhone('+12065550101');
  expect(maya!.name).toBe('Maya Chen');
  expect(maya!.embedding).toHaveLength(1536);
  expect(maya!.canonicalProfile).toMatch(/^Core Interests:\n\[1\]/);
});

test('seed writes each history in order, in = user / out = mixr, with increasing timestamps before now', async () => {
  await fresh();
  await seed();
  const clock = (await now()).getTime();
  for (const u of loadSeedUsers()) {
    const rows = await messagesFor(u.phone);
    expect(rows.map((r) => [r.direction, r.text]), u.name).toEqual(u.history.map((m) => [m.from === 'user' ? 'in' : 'out', m.text]));
    const ts = rows.map((r) => new Date(r.sim_time).getTime());
    expect(ts[0], u.name).toBe(clock - u.onboardedDaysAgo * DAY);
    for (let i = 1; i < ts.length; i++) {
      const gap = ts[i] - ts[i - 1];
      expect(gap, `${u.name} #${i}`).toBeGreaterThan(0);
      if (!u.history[i].gapHours) expect(gap, `${u.name} #${i}`).toBeLessThanOrEqual(3 * 60_000);
      else expect(gap, `${u.name} #${i}`).toBeGreaterThanOrEqual(u.history[i].gapHours! * 3600_000);
    }
    expect(ts[ts.length - 1], u.name).toBeLessThan(clock);
  }
});

test('seed upgrades an existing onboarding user with the same phone and gives them history', async () => {
  await fresh();
  await q(`INSERT INTO users (phone) VALUES ('+12065550101')`);
  await seed();
  const maya = await getUserByPhone('+12065550101');
  expect(maya!.state).toBe('active');
  expect(maya!.seeded).toBe(true);
  expect(await messagesFor('+12065550101')).toHaveLength(loadSeedUsers()[0].history.length);
});

test('a user who already has messages keeps their conversation; seed adds no history', async () => {
  await fresh();
  const t = (await now()).toISOString();
  const [{ id }] = await q<{ id: number }>(`INSERT INTO users (phone) VALUES ('+12065550102') RETURNING id`);
  await q(`INSERT INTO messages (user_id, direction, text, sim_time) VALUES ($1, 'in', 'hey is this mixr', $2)`, [id, t]);
  await seed();
  expect((await messagesFor('+12065550102')).map((r) => r.text)).toEqual(['hey is this mixr']);
  // everyone else still got theirs
  const mayaLen = loadSeedUsers()[0].history.length;
  expect(await messagesFor('+12065550101')).toHaveLength(mayaLen);
  // a live conversation that continues after seeding survives a re-seed untouched
  await q(`INSERT INTO messages (user_id, direction, text, sim_time) SELECT id, 'in', 'new text', $1 FROM users WHERE phone = '+12065550101'`, [t]);
  await seed();
  const maya = await messagesFor('+12065550101');
  expect(maya).toHaveLength(mayaLen + 1);
  expect(maya[maya.length - 1].text).toBe('new text');
});
