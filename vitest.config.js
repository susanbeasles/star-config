import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.js'],
    testTimeout: 60_000,
    coverage: { provider: 'v8', include: ['src/**'], reporter: ['text', 'lcov'] },
  },
});
