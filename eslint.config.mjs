// ESLint — bug-focused linting for the browser ES modules. Dev/CI only; the app
// itself ships no runtime npm dependencies. Catches the classes of mistake the
// no-build setup otherwise only surfaces at runtime: undefined names (e.g. the
// `api` import that once slipped through), unused vars/imports, unreachable
// code, duplicate keys. NOT a style enforcer — formatting rules are omitted so
// it never fights the existing hand-tuned style.
//
//   npx eslint web-editor/js        # or: npm run lint:js
import js from '@eslint/js';
import globals from 'globals';
import simpleImportSort from 'eslint-plugin-simple-import-sort';

export default [
  // generated data modules — not hand-written, don't lint
  { ignores: ['web-editor/functions/valueTables.js', 'web-editor/functions/fxData.js'] },

  js.configs.recommended,

  {
    files: ['web-editor/**/*.js'],
    plugins: { 'simple-import-sort': simpleImportSort },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.browser,
    },
    rules: {
      // flag genuinely-unused locals/imports; ignore unused function args and
      // caught-error bindings (often intentional placeholders here)
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      // auto-sortable import/export ordering (statements grouped, members A–Z)
      'simple-import-sort/imports': 'error',
      'simple-import-sort/exports': 'error',
      // simple-import-sort sorts but doesn't format; this keeps the reordered
      // `{ a, b }` members space-separated (core rule; deprecated in ESLint 9
      // but still functional — swap to @stylistic if a future major drops it).
      'comma-spacing': ['error', { before: false, after: true }],
    },
  },
];
