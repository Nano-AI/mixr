import { one, q } from './db/index.ts';
import { publish } from './bus.ts';

// Simulated time. Everything time-based (waves, expiries, "tonight") reads this, never Date.now().

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

export async function now(): Promise<Date> {
  const r = await one<{ now: string }>('SELECT now FROM clock WHERE id = 1');
  return new Date(r!.now);
}

export async function setNow(t: Date): Promise<void> {
  await q('UPDATE clock SET now = $1 WHERE id = 1', [t.toISOString()]);
  publish({ type: 'clock', now: t.toISOString() });
}
