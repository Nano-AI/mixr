import { q } from './db/index.ts';
import { publish } from './bus.ts';
import { now } from './clock.ts';
import type { TraceKind } from './types.ts';

// Structured log the inspector renders. Keep `data` JSON-serializable and small (no raw 1536-d vectors).
export async function trace(kind: TraceKind, refId: number | null, data: unknown): Promise<void> {
  const t = (await now()).toISOString();
  await q('INSERT INTO traces (sim_time, kind, ref_id, data) VALUES ($1, $2, $3, $4)', [t, kind, refId, JSON.stringify(data)]);
  publish({ type: 'trace', kind, refId, data, simTime: t });
}
