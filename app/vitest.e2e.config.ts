import { svelte } from '@sveltejs/vite-plugin-svelte';
import { configDefaults, defineConfig } from 'vitest/config';

// The slow end-to-end tests (`test/**/*.e2e.test.ts`): the solver on real plans with real time budgets. `npm test`
// leaves them out (vite.config.ts); `npm run test:e2e` runs only them, `npm run test:all` runs both. The deep ladder sweeps
// (`test/ladder-sweep-deep*.e2e.test.ts`) take tens of minutes and have their own script, `npm run test:sweep-deep`
// (vitest.sweep-deep.config.ts).
export default defineConfig({
  plugins: [svelte()],
  server: {
    fs: { allow: ['..'] },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.e2e.test.ts'],
    exclude: [...configDefaults.exclude, 'test/ladder-sweep-deep*.e2e.test.ts'],
  },
});
