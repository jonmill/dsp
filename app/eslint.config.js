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
    // geometry/model.ts but must never reach into the layout solver. Any import path with a
    // segment named `layout` is the solver (`../layout`, `../layout/x`, `../../layout`, `../../lib/layout/x`,
    // `$lib/layout`), the directory itself included. A dynamic import() or a require() cannot be told from its
    // argument (`import(path)`), so the validator takes none: they are refused whatever they name.
    files: ['src/lib/validate/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [{ regex: '(^|/)layout(/|$)', message: 'validator must stay independent of the solver' }],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ImportExpression',
          message: 'validator must stay independent of the solver: it takes no dynamic import(), which cannot be checked',
        },
        {
          selector: "CallExpression[callee.name='require']",
          message: 'validator must stay independent of the solver: it takes no require(), which cannot be checked',
        },
      ],
    },
  },
]);
