import { fromVec, q } from './db/index.ts';
import { dot } from './vec.ts';

export type ProjectionPoint = { id: string; label: string; kind: 'user' | 'event0' | 'eventT'; eventId?: number; x: number; y: number };

const ITERATIONS = 50; // tune: power-iteration steps per component
const EPS = 1e-12;

// 2D PCA fitted on active users' vectors; events' E0 and Et are projected with the same transform.
export async function projection(): Promise<{ points: ProjectionPoint[] }> {
  const users = await q<{ id: number; name: string | null; e: string }>(
    `SELECT id, name, embedding::text AS e FROM users WHERE state = 'active' AND embedding IS NOT NULL ORDER BY id`,
  );
  const events = await q<{ id: number; title: string; e0: string; et: string }>(
    `SELECT id, title, initial_embedding::text AS e0, current_embedding::text AS et FROM events WHERE status <> 'cancelled' ORDER BY id`,
  );

  const raw: { id: string; label: string; kind: ProjectionPoint['kind']; eventId?: number; v: number[] }[] = [];
  for (const u of users) raw.push({ id: `u${u.id}`, label: u.name ?? `user ${u.id}`, kind: 'user', v: fromVec(u.e)! });
  for (const ev of events) {
    raw.push({ id: `e${ev.id}:0`, label: ev.title, kind: 'event0', eventId: ev.id, v: fromVec(ev.e0)! });
    raw.push({ id: `e${ev.id}:t`, label: ev.title, kind: 'eventT', eventId: ev.id, v: fromVec(ev.et)! });
  }
  if (raw.length === 0) return { points: [] };

  const userVecs = raw.filter((p) => p.kind === 'user').map((p) => p.v);
  const { mean, components } = fitPca(userVecs, raw[0].v.length, 2);

  const coords = raw.map((p) => {
    const c = p.v.map((x, i) => x - mean[i]);
    return components.map((pc) => dot(c, pc));
  });

  // Scale each axis independently so the farthest point sits at ±1.
  const scales = [0, 1].map((k) => Math.max(...coords.map((c) => Math.abs(c[k]))));
  const fit = (x: number, s: number) => (s > EPS && Number.isFinite(x) ? x / s : 0);

  return {
    points: raw.map((p, i) => ({
      id: p.id,
      label: p.label,
      kind: p.kind,
      ...(p.eventId !== undefined ? { eventId: p.eventId } : {}),
      x: fit(coords[i][0], scales[0]),
      y: fit(coords[i][1], scales[1]),
    })),
  };
}

// Top-k principal components by power iteration on XᵀX without materializing it (v → Xᵀ(Xv)), with
// deflation by re-orthogonalizing against earlier components each step. Degenerate components are zero.
export function fitPca(rows: number[][], dims: number, k: number): { mean: number[]; components: number[][] } {
  const mean = new Array(dims).fill(0);
  for (const r of rows) for (let i = 0; i < dims; i++) mean[i] += r[i] / rows.length;
  const X = rows.map((r) => r.map((x, i) => x - mean[i]));

  const components: number[][] = [];
  for (let c = 0; c < k; c++) {
    // Deterministic, non-degenerate start vector.
    let v = Array.from({ length: dims }, (_, i) => Math.sin(1 + i * (c + 1.618)));
    let ok = false;
    for (let it = 0; it < ITERATIONS; it++) {
      v = orthogonalize(v, components);
      const n0 = Math.sqrt(dot(v, v));
      if (n0 < EPS) break;
      v = v.map((x) => x / n0);
      const xv = X.map((r) => dot(r, v));
      const next = new Array(dims).fill(0);
      for (let j = 0; j < X.length; j++) {
        const s = xv[j];
        if (s === 0) continue;
        const r = X[j];
        for (let i = 0; i < dims; i++) next[i] += s * r[i];
      }
      const w = orthogonalize(next, components);
      const n = Math.sqrt(dot(w, w));
      if (n < EPS) { ok = false; break; }
      v = w.map((x) => x / n);
      ok = true;
    }
    if (!ok) { components.push(new Array(dims).fill(0)); continue; }
    // Canonical sign: largest-magnitude coordinate positive, so the layout doesn't flip between runs.
    let big = 0;
    for (let i = 1; i < dims; i++) if (Math.abs(v[i]) > Math.abs(v[big])) big = i;
    components.push(v[big] < 0 ? v.map((x) => -x) : v);
  }
  return { mean, components };
}

function orthogonalize(v: number[], basis: number[][]): number[] {
  let out = v;
  for (const b of basis) {
    const p = dot(out, b);
    if (p !== 0) out = out.map((x, i) => x - p * b[i]);
  }
  return out;
}
