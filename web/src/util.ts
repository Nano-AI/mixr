// Formatting helpers. All times display in the campus timezone, from simulated-clock ISO strings.
export const TZ = 'America/Los_Angeles';

const fmt = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, ...opts });
const clockFmt = fmt({ weekday: 'short', hour: 'numeric', minute: '2-digit' });
const dateFmt = fmt({ month: 'short', day: 'numeric' });
const timeFmt = fmt({ hour: 'numeric', minute: '2-digit' });
const whenFmt = fmt({ weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const dayKeyFmt = fmt({ year: 'numeric', month: '2-digit', day: '2-digit' });
const dayLabelFmt = fmt({ weekday: 'long', month: 'short', day: 'numeric' });

const valid = (iso: string | null | undefined): iso is string => !!iso && !Number.isNaN(new Date(iso).getTime());

export const fmtClock = (iso: string) => (valid(iso) ? clockFmt.format(new Date(iso)) : '—');
export const fmtDate = (iso: string) => (valid(iso) ? dateFmt.format(new Date(iso)) : '—');
export const fmtTime = (iso: string) => (valid(iso) ? timeFmt.format(new Date(iso)) : '—');
export const fmtWhen = (iso: string | null | undefined) => (valid(iso) ? whenFmt.format(new Date(iso)) : '—');
export const dayKey = (iso: string) => (valid(iso) ? dayKeyFmt.format(new Date(iso)) : '');
export const fmtDayLabel = (iso: string) => (valid(iso) ? dayLabelFmt.format(new Date(iso)) : '');

/** "in 2h 5m" / "3d ago" relative to the sim clock. */
export function fmtRel(iso: string | null | undefined, nowIso: string | undefined): string {
  if (!valid(iso) || !valid(nowIso)) return '';
  const diff = new Date(iso).getTime() - new Date(nowIso).getTime();
  const abs = Math.abs(diff);
  const m = Math.round(abs / 60_000);
  let s: string;
  if (m < 1) return 'now';
  if (m < 60) s = `${m}m`;
  else if (m < 60 * 24) {
    const h = Math.floor(m / 60);
    const rm = m % 60;
    s = rm ? `${h}h ${rm}m` : `${h}h`;
  } else {
    const hours = Math.round(m / 60); // round once, so it never reads "2d 24h"
    const d = Math.floor(hours / 24);
    const h = hours % 24;
    s = h ? `${d}d ${h}h` : `${d}d`;
  }
  return diff >= 0 ? `in ${s}` : `${s} ago`;
}

export function fmtPhone(p: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(p);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : p;
}

export function randomPhone(): string {
  let d = '';
  for (let i = 0; i < 7; i++) d += Math.floor(Math.random() * 10);
  return `+1555${d}`;
}

export const fmtNum = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : n.toLocaleString('en-US'));

export const initials = (name: string | null | undefined) =>
  (name ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('') || '#';

export const firstName = (name: string | null | undefined) => (name ?? '').split(/\s+/)[0] || null;

export const cx = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(' ');

/** JSON.stringify with sorted keys, for de-duplicating payloads from different sources. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'undefined';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(',')}}`;
}

export function loadLocal<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function saveLocal(key: string, v: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* storage unavailable */
  }
}
