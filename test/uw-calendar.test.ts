import { test, expect } from 'vitest';
import { fresh, T0 } from './helpers.ts';
import { q } from '../src/db/index.ts';
import { importUwEvents, isStudentRelevant, parseIcs, scrubPii, type UwEvent } from '../src/calendar/uw.ts';

// Invented events, people and contacts (example.com, 555 numbers only). T0 is Tue 2026-10-20 noon PDT.
const ICS = [
  'BEGIN:VCALENDAR',
  'BEGIN:VEVENT',
  'SUMMARY:Intro to Bouldering Night',
  'LOCATION:Intramural Activities Building (IMA)',
  'DTSTART;TZID=America/Los_Angeles:20261022T180000',
  'DTEND;TZID=America/Los_Angeles:20261022T200000',
  'X-TRUMBA-CUSTOMFIELD;NAME="Event Types";ID=1;TYPE=CustomAsset:Student Activities\\, Athletics',
  'X-TRUMBA-CUSTOMFIELD;NAME="Accessibility Contact";ID=2;TYPE=SingleLine:access@example.com',
  'DESCRIPTION:Accessibility Contact: access@example.com\\nEvent Types: Student Activities\\n\\nNo experien',
  ' ce needed\\, shoes provided.\\nContact: Maya Rivers\\nOrganizer - Jordan Lee\\nQuestions? Ask at the front des',
  ' k.\\nEmail priya@example.com or call (206) 555-0142 or +1 425 555 0199.',
  'UID:http://uid.trumba.com/event/1001',
  'URL:https://example.com/bouldering',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'SUMMARY:Library Closed for Veterans Day',
  'LOCATION:Suzzallo Library',
  'DTSTART;VALUE=DATE:20261111',
  'UID:http://uid.trumba.com/event/1002',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'SUMMARY:Board Game Social',
  'LOCATION:HUB 145',
  'DTSTART:20261024T020000Z',
  'X-TRUMBA-CUSTOMFIELD;NAME="Event Types";ID=1;TYPE=CustomAsset:Special Events',
  'UID:http://uid.trumba.com/event/1003',
  'X-TRUMBA-LINK:https://www.washington.edu/calendar/?eventid=1003',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'SUMMARY:Supervisor Staff Training: Payroll Basics',
  'LOCATION:Roosevelt Commons',
  'DTSTART;TZID=America/Los_Angeles:20261023T090000',
  'UID:http://uid.trumba.com/event/1004',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'SUMMARY:Spring Registration Opens',
  'LOCATION:Online',
  'DTSTART;TZID=America/Los_Angeles:20261026T090000',
  'X-TRUMBA-CUSTOMFIELD;NAME="Event Type";ID=21;TYPE=number:Important Dates/Deadlines',
  'UID:http://uid.trumba.com/event/1005',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

test('parseIcs: unfolds lines, TZID / Z / all-day times, fields, category', () => {
  const evs = parseIcs(ICS);
  expect(evs).toHaveLength(5);
  const [climb, closed, games] = evs;
  expect(climb.title).toBe('Intro to Bouldering Night');
  expect(climb.startsAt).toBe('2026-10-23T01:00:00.000Z'); // 6pm PDT
  expect(climb.endsAt).toBe('2026-10-23T03:00:00.000Z');
  expect(climb.allDay).toBe(false);
  expect(climb.category).toBe('Student Activities, Athletics');
  expect(climb.url).toBe('https://example.com/bouldering');
  expect(climb.description).toMatch(/^No experience needed, shoes provided\./); // folded mid-word, Trumba header gone
  expect(closed.allDay).toBe(true);
  expect(closed.startsAt).toBe('2026-11-11T08:00:00.000Z'); // midnight PST (after the DST change)
  expect(games.startsAt).toBe('2026-10-24T02:00:00.000Z');
  expect(games.url).toBe('https://www.washington.edu/calendar/?eventid=1003');
  expect(evs[4].category).toBe('Important Dates/Deadlines');
});

test('scrubPii: emails, phones, contact/organizer lines; length cap', () => {
  const d = parseIcs(ICS)[0].description;
  for (const bad of ['@', 'example.com', '555', 'Maya', 'Jordan', 'Questions', 'Accessibility']) expect(d).not.toContain(bad);
  expect(scrubPii('reach sam@example.com or 206.555.0123 today')).toBe('reach or today');
  const long = scrubPii('word '.repeat(200), 400);
  expect(long.length).toBeLessThanOrEqual(401);
  expect(long.endsWith('…')).toBe(true);
});

test('isStudentRelevant: skips closures, all-day, staff trainings, deadlines', () => {
  expect(parseIcs(ICS).filter(isStudentRelevant).map((e) => e.title)).toEqual(['Intro to Bouldering Night', 'Board Game Social']);
});

test('importUwEvents: demo pool, discover-only, idempotent by UID', async () => {
  await fresh(); // demo clock at T0
  const evs: UwEvent[] = [
    ...parseIcs(ICS),
    { uid: 'far', title: 'Too Far Out', startsAt: new Date(T0.getTime() + 20 * 86400_000).toISOString(), endsAt: null, allDay: false, location: 'HUB', description: '', url: null },
  ];
  const dry = await importUwEvents(evs, { dryRun: true });
  expect(dry.candidates.map((e) => e.uid)).toEqual(['http://uid.trumba.com/event/1001', 'http://uid.trumba.com/event/1003']);
  expect((await q('SELECT 1 FROM events')).length).toBe(0);

  const first = await importUwEvents(evs);
  expect(first.inserted).toBe(2);
  const again = await importUwEvents(evs);
  expect(again).toMatchObject({ inserted: 0, existing: 2 });

  const rows = await q<{ source_uid: string; seeded: boolean; hyde_profile: string; next_wave_at: string | null }>(
    `SELECT e.source_uid, h.seeded, e.hyde_profile, e.next_wave_at FROM events e JOIN users h ON h.id = e.host_id ORDER BY e.id`,
  );
  expect(rows).toHaveLength(2);
  for (const r of rows) {
    expect(r.seeded).toBe(true); // demo pool
    expect(r.hyde_profile).toBeTruthy();
    expect(r.next_wave_at).toBeNull();
  }
  expect((await q(`SELECT 1 FROM jobs WHERE kind = 'wave'`)).length).toBe(0); // never invites anyone
});
