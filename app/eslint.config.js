import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';
import ts from 'typescript-eslint';

export default defineConfig([
  globalIgnores(['dist/', 'node_modules/', 'public/icons/']),
  js.configs.recommended,
  ts.configs.recommended,
  svelte.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
  },
  {
    files: ['**/*.svelte', '**/*.svelte.ts'],
    languageOptions: {
      parserOptions: { parser: ts.parser },
    },
  },
  {
    // The validator is the independent check on solver output, so it may share
    // geometry/model.ts but must never reach into the layout solver.
    files: ['src/lib/validate/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/lib/layout/**', '../layout/*', '../../layout/*', '$lib/layout/*'],
              message: 'validator must stay independent of the solver',
            },
          ],
        },
      ],
    },
  },
]);
