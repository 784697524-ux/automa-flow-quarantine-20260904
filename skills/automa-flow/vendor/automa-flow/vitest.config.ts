import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 20_000,
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.sandbox/**',
    ],
  },
});
