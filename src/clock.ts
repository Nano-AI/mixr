import { one, q } from './db/index.ts';
import { publish } from './bus.ts';
import { currentPool } from './context.ts';

// Time, per pool. Everything time-based (waves, expiries, "tonight") reads now(), never Date.now() directly.
//   real pool: the wall clock.
//   demo pool: a simulated clock stored in the DB that only moves when the dashboard fast-forwards.

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

export async function now(): Promise<Date> {
  return currentPool() === 'real' ? new Date() : demoNow();
}

export async function demoNow(): Promise<Date> {
  const r = await one<{ now: string }>('SELECT now FROM clock WHERE id = 1');
  return new Date(r!.now);
}

// Moves the demo clock only; the real pool always runs on the wall clock.
export async function setNow(t: Date): Promise<void> {
  await q('UPDATE clock SET now = $1 WHERE id = 1', [t.toISOString()]);
  publish({ type: 'clock', now: t.toISOString() });
}
