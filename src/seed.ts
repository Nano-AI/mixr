import { readFileSync } from 'node:fs';
import { one, q, toVec } from './db/index.ts';
import { embed } from './llm/embed.ts';
import { HOUR, now } from './clock.ts';

// One text in a seeded user's hand-written onboarding conversation. gapHours marks a later exchange
// (that many hours after the previous text) instead of the usual minute-or-two reply gap.
export type SeedMessage = { from: 'user' | 'mixr'; text: string; gapHours?: number };

export type SeedUser = {
  name: string;
  phone: string;
  profile: string;
  onboardedDaysAgo: number; // the conversation starts this many days before the sim clock's now
  history: SeedMessage[];
};

const FIXTURE = new URL('../fixtures/seed-users.json', import.meta.url);
const DAY = 24 * HOUR;

// tune: seconds between seeded texts, [min, max]. mixr answers in about a minute, people take a bit
// longer, and a double text (someone splitting their braindump) follows quickly.
const GAP_SECONDS = { mixrReply: [40, 90], userReply: [90, 180], doubleText: [15, 45] } as const;

export function loadSeedUsers(): SeedUser[] {
  return JSON.parse(readFileSync(FIXTURE, 'utf8')) as SeedUser[];
}

// Deterministic jitter in [0, 1) so seeding a fresh DB always yields the same timeline.
const jitter = (a: number, b: number): number => {
  const x = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
  return x - Math.floor(x);
};

// Sim timestamps for a history: the first text at `start`, then strictly increasing.
export function historyTimes(history: SeedMessage[], start: Date, salt = 0): Date[] {
  let t = start.getTime();
  return history.map((m, i) => {
    if (i > 0) {
      const prev = history[i - 1];
      const [lo, hi] =
        prev.from === m.from ? GAP_SECONDS.doubleText : m.from === 'mixr' ? GAP_SECONDS.mixrReply : GAP_SECONDS.userReply;
      t += (m.gapHours ?? 0) * HOUR + Math.round((lo + jitter(salt, i) * (hi - lo)) * 1000);
    }
    return new Date(t);
  });
}

// Upserts every fixture user by phone as an active, seeded user. Idempotent; the only external call is
// one batched embed() (real API is cached by text, so re-seeding is free). A user's onboarding history is
// written only if they have no messages yet, so re-seeding never duplicates it and never clobbers a
// conversation someone is having in the simulator. Rows go straight into messages (not transport.send) so
// seeding doesn't publish a bus event per text.
export async function seed(): Promise<number> {
  const users = loadSeedUsers();
  const vectors = await embed(users.map((u) => u.profile));
  const clock = await now();
  for (const [i, u] of users.entries()) {
    const [{ id }] = await q<{ id: number }>(
      `INSERT INTO users (phone, name, state, canonical_profile, embedding, seeded)
       VALUES ($1, $2, 'active', $3, $4, true)
       ON CONFLICT (phone) DO UPDATE SET name = EXCLUDED.name, state = 'active',
         canonical_profile = EXCLUDED.canonical_profile, embedding = EXCLUDED.embedding, seeded = true
       RETURNING id`,
      [u.phone, u.name, u.profile, toVec(vectors[i])],
    );
    const history = u.history ?? [];
    if (!history.length || (await one('SELECT 1 FROM messages WHERE user_id = $1 LIMIT 1', [id]))) continue;
    const times = historyTimes(history, new Date(clock.getTime() - u.onboardedDaysAgo * DAY), i + 1);
    const params: unknown[] = [id];
    const rows = history.map((m, j) => {
      params.push(m.from === 'user' ? 'in' : 'out', m.text, times[j].toISOString());
      return `($1, $${params.length - 2}, $${params.length - 1}, $${params.length})`;
    });
    await q(`INSERT INTO messages (user_id, direction, text, sim_time) VALUES ${rows.join(', ')}`, params);
  }
  return users.length;
}
