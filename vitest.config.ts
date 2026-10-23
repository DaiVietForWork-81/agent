import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    pool: 'forks',
    testTimeout: 30000,
    env: {
      MADW_TEST: '1',
    },
  },
});
