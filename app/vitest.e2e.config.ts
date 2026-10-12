import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

// The slow end-to-end tests (`test/**/*.e2e.test.ts`): the solver on real plans with real time budgets. `npm test`
// leaves them out (vite.config.ts); `npm run test:e2e` runs only them, `npm run test:all` runs both.
export default defineConfig({
  plugins: [svelte()],
  server: {
    fs: { allow: ['..'] },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.e2e.test.ts'],
  },
});
