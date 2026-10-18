import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    env: { MIXR_FAKE: '1', DB_DIR: 'memory://' },
    fileParallelism: false,
    // Integration tests seed PGlite and run several matching rounds; slower machines (the deploy gate on
    // polarcrest) need more than the 5s default.
    testTimeout: 30_000,
  },
});
