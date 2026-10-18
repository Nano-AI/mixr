import { one, q } from '../db/index.ts';
import { now, setNow } from '../clock.ts';
import { publish } from '../bus.ts';
import { trace } from '../trace.ts';

// Background work keyed to simulated time. Modules register handlers at import time;
// advancing the clock runs every due job in run_at order, setting the clock to each job's time first.

export type JobKind = 'wave' | 'close_event' | 'evolve_profile' | 'expire_intro';
type Handler = (payload: any) => Promise<void>;

const handlers = new Map<JobKind, Handler>();

export const registerJob = (kind: JobKind, fn: Handler): void => void handlers.set(kind, fn);

export async function schedule(kind: JobKind, payload: Record<string, unknown>, runAt: Date): Promise<void> {
  await q('INSERT INTO jobs (kind, payload, run_at) VALUES ($1, $2, $3)', [kind, JSON.stringify(payload), runAt.toISOString()]);
}

// Run everything due at or before `until`. Jobs scheduled by jobs (e.g. the next wave) also run if due.
export async function runDue(until?: Date): Promise<number> {
  const end = until ?? (await now());
  let ran = 0;
  for (;;) {
    const job = await one<{ id: number; kind: JobKind; payload: any; run_at: string }>(
      'SELECT id, kind, payload, run_at FROM jobs WHERE NOT done AND run_at <= $1 ORDER BY run_at, id LIMIT 1',
      [end.toISOString()],
    );
    if (!job) break;
    await q('UPDATE jobs SET done = true WHERE id = $1', [job.id]);
    const at = new Date(job.run_at);
    if (at > (await now())) await setNow(at);
    const fn = handlers.get(job.kind);
    try {
      if (!fn) throw new Error(`no handler registered for job '${job.kind}'`);
      await fn(job.payload);
      await trace('job', job.id, { kind: job.kind, payload: job.payload });
    } catch (e) {
      await trace('job', job.id, { kind: job.kind, payload: job.payload, error: String(e) });
    }
    ran++;
  }
  if (ran) publish({ type: 'state' });
  return ran;
}

// Fast-forward: run due jobs along the way, then land exactly on the target time.
export async function advance(ms: number): Promise<number> {
  const target = new Date((await now()).getTime() + ms);
  const ran = await runDue(target);
  await setNow(target);
  return ran;
}
