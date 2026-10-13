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
    // argument (`import(path)`), so the validator takes none: they are refused whatever they name. An import type
    // (`import('../layout').Solve`) names its path, so it is matched like an import.
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
        {
          // `import('../layout').Solve` as a type (the path is `source` of the node, or the literal inside `argument` in other
          // parser versions). The selector's regex cannot hold a slash, so \x2f stands for it: the same layout path segment as above.
          selector:
            'TSImportType > Literal.source[value=/(^|\\x2f)layout(\\x2f|$)/], TSImportType > TSLiteralType > Literal[value=/(^|\\x2f)layout(\\x2f|$)/]',
          message: 'validator must stay independent of the solver: it takes no import type of the layout directory',
        },
      ],
    },
  },
]);
