// Loads fixtures/seed-users.json into the DB: users plus their onboarding texts (only for users with no
// messages yet). Calls the embeddings API (cached) unless MIXR_FAKE=1.
import { seed } from '../src/seed.ts';

const n = await seed();
console.log(`seeded ${n} users (onboarding histories added where a user had no messages)`);
process.exit(0);
