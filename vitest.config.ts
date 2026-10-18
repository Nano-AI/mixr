import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    env: { MIXR_FAKE: '1', DB_DIR: 'memory://' },
    fileParallelism: false,
  },
});
