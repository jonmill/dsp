import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

// The deep ladder sweeps (`test/ladder-sweep-deep*.e2e.test.ts`, Task 30b): too slow for `npm run test:e2e`, which leaves them out
// (vitest.e2e.config.ts). `npm run test:sweep-deep` runs only them.
export default defineConfig({
  plugins: [svelte()],
  server: {
    fs: { allow: ['..'] },
  },
  test: {
    environment: 'node',
    include: ['test/ladder-sweep-deep*.e2e.test.ts'],
  },
});
