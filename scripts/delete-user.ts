// Removes one REAL user (by phone, E.164) and everything tied to them from the database. Photon is untouched.
// Stop the server first (one PGlite process at a time):
//   systemctl --user stop mixr && node --import tsx scripts/delete-user.ts +12065551234 --yes && systemctl --user start mixr
import { deleteRealUser } from '../src/ops/resetReal.ts';

const phone = process.argv.find((a) => /^\+[1-9]\d{7,14}$/.test(a));
if (!phone || !process.argv.includes('--yes')) {
  console.error('usage: delete-user.ts <+E164 phone> --yes');
  process.exit(1);
}
const r = await deleteRealUser(phone);
console.log(r.deleted ? `deleted real user ..${phone.slice(-4)} and their data` : `no user with ..${phone.slice(-4)}`);
process.exit(0);
