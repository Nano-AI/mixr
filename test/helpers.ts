import { db, toBlob } from '../src/db.ts';
import type { Category } from '../src/types.ts';

const DIM = 384;

export function axis(i: number): Float32Array {
  const v = new Float32Array(DIM);
  v[i] = 1;
  return v;
}

export function blend(a: Float32Array, b: Float32Array, t: number): Float32Array {
  const v = a.map((x, i) => (1 - t) * x + t * b[i]);
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
}

let n = 0;

// Inserts an active, confirmed user directly (skips onboarding).
export function makeUser(o: {
  phone?: string;
  name?: string;
  interests?: { label: string; vector: Float32Array; category?: Category }[];
  slots?: string[];
  mode?: 'pair' | 'group' | 'both';
  reliability?: number;
} = {}): number {
  n++;
  const interests = o.interests ?? [];
  const { lastInsertRowid } = db
    .prepare("INSERT INTO users (phone, name, step, mode, reliability) VALUES (?, ?, 'active', ?, ?)")
    .run(o.phone ?? `+1555${String(n).padStart(7, '0')}`, o.name ?? `User${n}`, o.mode ?? 'both', o.reliability ?? 1200);
  const id = Number(lastInsertRowid);
  const profile = {
    summary: interests.map((i) => i.label).join(', '),
    interests: interests.map((i) => ({ label: i.label, kind: 'does', level: 'casual', category: i.category ?? 'other' })),
    vibe: '',
    constraints: [],
  };
  db.prepare('INSERT INTO profiles (user_id, braindump, data, confirmed) VALUES (?, ?, ?, 1)').run(id, profile.summary, JSON.stringify(profile));
  const addInterest = db.prepare("INSERT INTO interests (user_id, label, kind, level, category, embedding) VALUES (?, ?, 'does', 'casual', ?, ?)");
  for (const i of interests) addInterest.run(id, i.label, i.category ?? 'other', toBlob(i.vector));
  const addSlot = db.prepare('INSERT INTO availability (user_id, slot) VALUES (?, ?)');
  for (const s of o.slots ?? []) addSlot.run(id, s);
  return id;
}
