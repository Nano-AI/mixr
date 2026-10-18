import { runIn, poolContext } from './context.ts';
import { runDue } from './jobs/index.ts';
import { retryPending } from './transport/outbox.ts';
import { maybeBackup } from './backup.ts';

// Background work for the real pool: due jobs on the wall clock (waves, expiries, profile learning),
// delivery retries, and the nightly database snapshot. Overlapping ticks are skipped, and a failed tick never takes the process down.

const TICK_MS = 15_000; // tune:

let timer: ReturnType<typeof setInterval> | undefined;
let busy = false;

export async function tick(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    await runIn(poolContext('real'), async () => {
      await runDue();
      await retryPending();
    });
    await maybeBackup();
  } catch (e) {
    console.error('tick failed; will retry:', e instanceof Error ? e.message : e);
  } finally {
    busy = false;
  }
}

export function startTicker(): void {
  timer ??= setInterval(() => void tick(), TICK_MS);
}

export function stopTicker(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
