import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/unit/**/*.test.js', 'tests/integration/**/*.test.js', 'tests/api/**/*.test.js'],
    setupFiles: ['tests/helpers/setup.js'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    sequence: { concurrent: false },
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
