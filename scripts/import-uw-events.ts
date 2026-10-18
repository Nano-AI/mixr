// Copies upcoming UW campus events (next 14 days, student-friendly, max 60) into the demo pool, hosted by the
// invented "UW Events" demo user. Reads the newest archived snapshot, or fetches + archives one if there is none.
// Idempotent by calendar UID. Calls Claude (HyDE) and the embeddings API per new event unless MIXR_FAKE=1.
//   npm run import:uw-events [-- --dry-run]
import { archiveSnapshot, fetchUwEvents, importUwEvents, latestSnapshot } from '../src/calendar/uw.ts';

const dryRun = process.argv.includes('--dry-run');
let events = latestSnapshot();
if (!events) {
  events = await fetchUwEvents();
  console.log(`no snapshot yet; fetched ${events.length} events -> ${archiveSnapshot(events)}`);
}
const r = await importUwEvents(events, { dryRun });
for (const e of r.candidates) console.log(`${e.startsAt.slice(0, 16)}  ${e.title}  @ ${e.location}`);
console.log(
  dryRun
    ? `dry run: ${r.candidates.length} candidates, ${r.candidates.length - r.existing} would be inserted, ${r.existing} already there`
    : `inserted ${r.inserted}, ${r.existing} already there`,
);
process.exit(0);
