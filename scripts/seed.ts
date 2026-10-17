// Loads fixtures/seed-users.json into the DB. Calls the embeddings API (cached) unless MIXR_FAKE=1.
import { seed } from '../src/seed.ts';

const n = await seed();
console.log(`seeded ${n} users`);
process.exit(0);
