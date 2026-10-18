import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.ts';
import { one, q } from '../db/index.ts';
import { HOUR, now } from '../clock.ts';
import { poolContext, runIn } from '../context.ts';
import { createEvent } from '../events/index.ts';
import { embed, embedOne } from '../llm/embed.ts';
import { dot } from '../vec.ts';
import { bm25, LEX_WEIGHT, rareTerms, weightedRrf } from '../matching/bm25.ts';

// UW's public events calendar (washington.edu/calendar runs on Trumba, web name "sea_campus"). Pulled once a day,
// scrubbed, and archived as JSON so we keep history after events drop off the feed. The import step copies
// upcoming student-friendly events into the demo pool, hosted by an invented demo user.

export const FEED_URL = 'https://www.trumba.com/calendars/sea_campus.ics';
const USER_AGENT = 'mixr-calendar/1.0 (+https://www.joinmixr.club)';
const DAY = 24 * HOUR;
const DESCRIPTION_MAX = 400; // tune: chars kept per description

export type UwEvent = {
  uid: string;
  title: string;
  startsAt: string; // ISO, UTC
  endsAt: string | null;
  allDay: boolean;
  location: string;
  description: string; // scrubbed
  url: string | null;
  category?: string; // Trumba "Event Types" (+ "Event Type" when it says something, like deadlines)
};

// ---------- ICS ----------

const unescape = (v: string): string => v.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');

// Offset (ms) of `tz` from UTC at instant `utc`.
function tzOffset(utc: number, tz: string): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
      .formatToParts(new Date(utc))
      .map((x) => [x.type, Number(x.value)]),
  );
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - utc;
}

// 20261018T180000 (+ TZID or trailing Z) or 20261018 (all-day, midnight in tz) -> ISO.
function icsTime(value: string, tz = 'America/Los_Angeles'): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value.trim());
  if (!m) return null;
  const local = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  if (m[7]) return new Date(local).toISOString();
  // Local wall time -> UTC; the second pass lands right across DST changes.
  let utc = local - tzOffset(local, tz);
  utc = local - tzOffset(utc, tz);
  return new Date(utc).toISOString();
}

// Minimal RFC 5545 reader: unfolds lines, reads VEVENTs. Ignores RRULE (Trumba expands every occurrence).
export function parseIcs(text: string): UwEvent[] {
  const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const out: UwEvent[] = [];
  let cur: { props: Map<string, { params: string; value: string }>; custom: Map<string, string> } | null = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') cur = { props: new Map(), custom: new Map() };
    else if (line === 'END:VEVENT' && cur) {
      const ev = toEvent(cur.props, cur.custom);
      if (ev) out.push(ev);
      cur = null;
    } else if (cur) {
      const m = /^([A-Z-]+)((?:;[^:]*)?):(.*)$/.exec(line);
      if (!m) continue;
      const [, name, params, value] = m;
      if (name === 'X-TRUMBA-CUSTOMFIELD') {
        const field = /NAME="([^"]+)"/.exec(params)?.[1];
        if (field) cur.custom.set(field, unescape(value));
      } else if (!cur.props.has(name)) cur.props.set(name, { params, value });
    }
  }
  return out;
}

function toEvent(props: Map<string, { params: string; value: string }>, custom: Map<string, string>): UwEvent | null {
  const get = (k: string) => (props.has(k) ? unescape(props.get(k)!.value).trim() : '');
  const time = (k: string) => {
    const p = props.get(k);
    if (!p) return null;
    return icsTime(p.value, /TZID=([^;:]+)/.exec(p.params)?.[1]);
  };
  const uid = get('UID');
  const startsAt = time('DTSTART');
  if (!uid || !startsAt) return null;
  // Trumba repeats its custom fields ("Campus room: ...", "Accessibility Contact: ...") at the top of DESCRIPTION.
  const fieldNames = [...custom.keys()];
  const body = get('DESCRIPTION')
    .split('\n')
    .filter((l) => !fieldNames.some((f) => l.startsWith(`${f}:`)))
    .join('\n');
  const type = custom.get('Event Type');
  const category = [custom.get('Event Types'), type && type !== 'Generic UW Event' ? type : ''].filter(Boolean).join(', ');
  return {
    uid,
    title: scrubPii(get('SUMMARY'), 200, false),
    startsAt,
    endsAt: time('DTEND'),
    allDay: /VALUE=DATE(;|$)/.test(props.get('DTSTART')!.params),
    location: scrubPii(get('LOCATION'), 200, false),
    description: scrubPii(body),
    url: [get('URL'), get('X-TRUMBA-LINK')].find((u) => /^https?:\/\//.test(u)) ?? null,
    ...(category ? { category } : {}),
  };
}

// ---------- PII ----------

const EMAIL = /\b(mailto:)?[\w.+-]+@[\w-]+(\.[\w-]+)+\b/gi;
const PHONE = /(\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
// "Contact: Jane Doe", "Contact Information: ...", "Event organizer - Jane", "Questions? ..." -> whole line goes.
const CONTACT_LINE = /^.*(\b(contact|organi[sz]er)s?\b[\w ]{0,25}(:|\s[-–]\s)|\bquestions\?).*$/gim;

// Removes emails, phone numbers and (descriptions only) contact/organizer lines, collapses whitespace, caps the length.
export function scrubPii(text: string, max = DESCRIPTION_MAX, contactLines = true): string {
  const s = (contactLines ? text.replace(CONTACT_LINE, '') : text)
    .replace(EMAIL, '')
    .replace(PHONE, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  return `${cut.slice(0, cut.lastIndexOf(' ') > max * 0.6 ? cut.lastIndexOf(' ') : max).trimEnd()}…`;
}

// ---------- fetch + archive ----------

// One request per run.
export async function fetchUwEvents(): Promise<UwEvent[]> {
  const res = await fetch(FEED_URL, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`UW calendar feed: HTTP ${res.status}`);
  return parseIcs(await res.text());
}

// Next to the database directory (DB_DIR is PGlite's own data dir, so not inside it), like backups/.
export const snapshotDir = (): string => join(config.dbDir, '..', 'uw-calendar');

// Writes the scrubbed list to <dir>/YYYY-MM-DD.json (same day = overwrite). Only scrubbed data ever hits disk.
export function archiveSnapshot(events: UwEvent[], dir = snapshotDir()): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${new Date().toISOString().slice(0, 10)}.json`);
  writeFileSync(file, JSON.stringify(events, null, 1));
  return file;
}

// Path of the newest YYYY-MM-DD.json in `dir`, or null.
function newestSnapshotFile(dir: string): string | null {
  try {
    const f = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().at(-1);
    return f ? join(dir, f) : null;
  } catch {
    return null;
  }
}

export function latestSnapshot(dir = snapshotDir()): UwEvent[] | null {
  const file = newestSnapshotFile(dir);
  return file ? (JSON.parse(readFileSync(file, 'utf8')) as UwEvent[]) : null;
}

export async function syncUwCalendar(): Promise<string | null> {
  if (config.dbDir.includes('://')) return null; // in-memory DB (tests): nowhere to archive
  const events = await fetchUwEvents();
  const file = archiveSnapshot(events);
  console.log(`uw calendar: ${events.length} events archived to ${file}`);
  return file;
}

// At server start, then every 24h. Failures log and wait for the next run.
export function startUwCalendar(): void {
  if (!config.uwCalendar) return;
  const run = () => syncUwCalendar().catch((e) => console.error('uw calendar sync failed:', e instanceof Error ? e.message : e));
  void run();
  setInterval(run, DAY).unref();
}

// ---------- demo import ----------

// Not for a student meetup: closures, cancellations, deadlines, staff/faculty business, recruiting info sessions,
// and anything online (mixr is for meeting in person).
const SKIP_TITLE =
  /\b(clos(ed|es|ure|ing)|cancel+ed|postponed|deadlines?|holiday|due|payroll|retirement|surplus|trainings?|staff|faculty|employees?|regents|senate|administration|webinar)\b/i;
const SKIP_CATEGORY = /\b(important dates|deadlines|information sessions|meetings)\b/i;
const SKIP_LOCATION = /\b(online|zoom|virtual|teams|tbd|tba)\b/i;

// No location is fine for discovery (the feed leaves it blank for plenty of real events); online ones still go.
const worthShowing = (e: UwEvent): boolean =>
  !!e.title &&
  !SKIP_TITLE.test(e.title) &&
  !SKIP_CATEGORY.test(e.category ?? '') &&
  !SKIP_LOCATION.test(e.location);

// The demo import wants timed events only (an all-day one has no real start for an RSVP).
export const isStudentRelevant = (e: UwEvent): boolean => !e.allDay && !!e.location && worthShowing(e);

// ---------- campus events for discover_events (read-only) ----------

const CAMPUS_MAX = 8; // tune: campus events per discover result
const CAMPUS_WINDOW = 14 * DAY; // tune: how far ahead discover looks

// Newest snapshot's student-relevant events, plus embeddings filled in on first ranked use. Reloaded when a newer
// file shows up (or today's is rewritten). Never fetches: no snapshot = no campus events.
let campus: { key: string; events: UwEvent[]; vecs: Map<string, number[]> } | null = null;

// When it's over: its end, else the end of its day (all-day) or two hours in.
const endOf = (e: UwEvent): number => (e.endsAt ? Date.parse(e.endsAt) : Date.parse(e.startsAt) + (e.allDay ? 24 : 2) * HOUR);
// Folds plurals so keywords meet ("hackathons" ~ "HACKATHON"). ponytail: crude stemmer, swap for a real one if misses show up.
const fold = (text: string): string => text.replace(/\b(\w{3,}?)s\b/gi, '$1');

// UW calendar events that are on now or start within 14 days (multi-day ones like a hackathon included), one per
// title. Ranked by the request (embedding + keywords, fused), else by the student's interests (their profile
// embedding), else soonest first.
export async function campusEvents(query?: string, dir = snapshotDir(), interests?: number[] | null): Promise<UwEvent[]> {
  const file = newestSnapshotFile(dir);
  if (!file) return [];
  const key = `${file}:${statSync(file).mtimeMs}`;
  if (campus?.key !== key) campus = { key, events: (JSON.parse(readFileSync(file, 'utf8')) as UwEvent[]).filter(worthShowing), vecs: new Map() };
  const c = campus;
  const t = (await now()).getTime();
  const seen = new Set<string>();
  const upcoming = c.events
    .filter((e) => endOf(e) > t && Date.parse(e.startsAt) < t + CAMPUS_WINDOW)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
    .filter((e) => !seen.has(e.title.toLowerCase()) && !!seen.add(e.title.toLowerCase())); // weekly series: first only
  const ask = query?.trim();
  const qv = ask ? await embedOne(ask) : interests;
  if (!qv) return upcoming.slice(0, CAMPUS_MAX);
  const missing = upcoming.filter((e) => !c.vecs.has(e.uid));
  if (missing.length) (await embed(missing.map((e) => `${e.title}\n${e.description}`))).forEach((v, i) => c.vecs.set(missing[i].uid, v));
  const byVec = upcoming.map((e, i) => ({ i, s: dot(qv, c.vecs.get(e.uid)!) })).sort((a, b) => b.s - a.s).map((x) => x.i);
  if (!ask) return byVec.slice(0, CAMPUS_MAX).map((i) => upcoming[i]);
  // Keywords: only words rare in this set (a "hackathon", not "event"), so a common word can't outrank meaning.
  const docs = upcoming.map((e) => fold(`${e.title}\n${e.description}`));
  const lex = bm25([...rareTerms(fold(ask), docs)].join(' '), docs);
  const byLex = lex.map((s, i) => ({ i, s })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).map((x) => x.i);
  return weightedRrf([[byVec, 1], [byLex, LEX_WEIGHT]]).slice(0, CAMPUS_MAX).map((i) => upcoming[i]);
}

export const DEMO_HOST = { name: 'UW Events', phone: '+12065550199' }; // invented demo user, fictional 555-01xx
const WINDOW = 14 * DAY; // tune: how far ahead to import
const MAX_EVENTS = 60; // tune
const CAPACITY = 50; // tune: campus events have no real cap; this keeps "spots left" plausible

export type ImportResult = { candidates: UwEvent[]; inserted: number; existing: number };

// Upcoming relevant events -> demo-pool events (HyDE + embeddings via createEvent). Discover-only: never invites
// anyone, and the host is a seeded (demo) user, so nothing can reach a real phone. Idempotent by calendar UID.
export async function importUwEvents(events: UwEvent[], opts: { dryRun?: boolean } = {}): Promise<ImportResult> {
  return runIn(poolContext('demo'), async () => {
    const t = (await now()).getTime();
    const seen = new Set<string>();
    const candidates = events
      .filter((e) => isStudentRelevant(e) && Date.parse(e.startsAt) > t && Date.parse(e.startsAt) < t + WINDOW)
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
      // A weekly series shouldn't eat the cap: first occurrence of each title only.
      .filter((e) => !seen.has(e.title.toLowerCase()) && !!seen.add(e.title.toLowerCase()))
      .slice(0, MAX_EVENTS);
    const have = new Set((await q<{ source_uid: string }>('SELECT source_uid FROM events WHERE source_uid IS NOT NULL')).map((r) => r.source_uid));
    const todo = candidates.filter((e) => !have.has(e.uid));
    if (opts.dryRun) return { candidates, inserted: 0, existing: candidates.length - todo.length };
    // No profile or embedding, so the host itself is never matched or suggested to anyone.
    const host = await one<{ id: number }>(
      `INSERT INTO users (phone, name, state, seeded, joined_via) VALUES ($1, $2, 'active', true, 'demo')
       ON CONFLICT (phone) DO UPDATE SET name = EXCLUDED.name WHERE users.seeded RETURNING id`,
      [DEMO_HOST.phone, DEMO_HOST.name],
    );
    if (!host) throw new Error(`${DEMO_HOST.phone} belongs to a real user; refusing to host demo events as them`);
    for (const e of todo) {
      const ev = await createEvent(
        host.id,
        { title: e.title, description: e.description || e.title, startsAt: new Date(e.startsAt), location: e.location, capacity: CAPACITY },
        { noInvites: true },
      );
      await q('UPDATE events SET source_uid = $2 WHERE id = $1', [ev.id, e.uid]);
    }
    return { candidates, inserted: todo.length, existing: candidates.length - todo.length };
  });
}
