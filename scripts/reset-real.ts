// Start the real pool over: deletes every real user and their data from the database and every user
// registration on the Photon project. Demo users stay. Stop the server first (one PGlite process at a time):
//   systemctl --user stop mixr && node --import tsx scripts/reset-real.ts --yes && systemctl --user start mixr
import { resetPhotonUsers, resetRealDb } from '../src/ops/resetReal.ts';

if (!process.argv.includes('--yes')) {
  console.error('This permanently deletes all REAL users (DB + Photon). Re-run with --yes.');
  process.exit(1);
}
const photon = await resetPhotonUsers();
console.log(`Photon: deleted ${photon.deleted.length} user(s) ${photon.deleted.join(' ')}`);
const dbr = await resetRealDb();
console.log(`Database: removed ${dbr.users} real user(s) and their data; demo users kept.`);
process.exit(0);
