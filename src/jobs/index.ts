import { one, q } from '../db/index.ts';
import { demoNow, now, setNow } from '../clock.ts';
import { publish } from '../bus.ts';
import { trace } from '../trace.ts';
import { currentPool, poolContext, runIn, type Pool } from '../context.ts';

// Background work keyed to time. Modules register handlers at import time. Each job belongs to the pool that
// scheduled it and runs on that pool's clock:
//   real pool: the server's ticker runs whatever is due on the wall clock.
//   demo pool: fast-forwarding runs every due job in run_at order, moving the demo clock to each job's time.

export type JobKind = 'wave' | 'close_event' | 'evolve_profile' | 'expire_intro';
type Handler = (payload: any) => Promise<void>;

const handlers = new Map<JobKind, Handler>();

export const registerJob = (kind: JobKind, fn: Handler): void => void handlers.set(kind, fn);

export async function schedule(kind: JobKind, payload: Record<string, unknown>, runAt: Date): Promise<void> {
  await q('INSERT INTO jobs (kind, payload, run_at, pool) VALUES ($1, $2, $3, $4)', [kind, JSON.stringify(payload), runAt.toISOString(), currentPool()]);
}

// Run everything in the current pool due at or before `until`. Jobs scheduled by jobs (the next wave) also run
// if due. Each job runs in its pool's own context, so real-pool jobs deliver even when triggered from the dashboard.
export async function runDue(until?: Date): Promise<number> {
  const pool: Pool = currentPool();
  const end = until ?? (await now());
  let ran = 0;
  for (;;) {
    const job = await one<{ id: number; kind: JobKind; payload: any; run_at: string }>(
      'SELECT id, kind, payload, run_at FROM jobs WHERE NOT done AND pool = $2 AND run_at <= $1 ORDER BY run_at, id LIMIT 1',
      [end.toISOString(), pool],
    );
    if (!job) break;
    await q('UPDATE jobs SET done = true WHERE id = $1', [job.id]);
    const at = new Date(job.run_at);
    if (pool === 'demo' && at > (await demoNow())) await setNow(at);
    const fn = handlers.get(job.kind);
    await runIn(poolContext(pool), async () => {
      try {
        if (!fn) throw new Error(`no handler registered for job '${job.kind}'`);
        await fn(job.payload);
        await trace('job', job.id, { kind: job.kind, payload: job.payload });
      } catch (e) {
        await trace('job', job.id, { kind: job.kind, payload: job.payload, error: String(e) });
      }
    });
    ran++;
  }
  if (ran) publish({ type: 'state' });
  return ran;
}

// Fast-forward the demo pool: run due jobs along the way, then land exactly on the target time.
export async function advance(ms: number): Promise<number> {
  return runIn(poolContext('demo'), async () => {
    const target = new Date((await demoNow()).getTime() + ms);
    const ran = await runDue(target);
    await setNow(target);
    return ran;
  });
}
