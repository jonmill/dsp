import { svelte } from '@sveltejs/vite-plugin-svelte';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [svelte()],
  server: {
    // Let the app import ../data/*.json (committed extraction output).
    fs: { allow: ['..'] },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // The slow end-to-end tests (minutes of real solver time) run with `npm run test:e2e`; see vitest.e2e.config.ts.
    exclude: [...configDefaults.exclude, 'test/**/*.e2e.test.ts'],
  },
});
