// ESLint: bug-focused linting for the browser ES modules (dev/CI only; the app
// ships no runtime npm dependencies). Catches what the build-free setup would
// otherwise only surface at runtime: undefined names, unused vars/imports,
// unreachable code, duplicate keys. Prettier owns formatting, so stylistic
// rules are left out (see .prettierrc).
//
//   npm run lint:js        # = eslint src/web-editor docs
import js from "@eslint/js";
import globals from "globals";
import simpleImportSort from "eslint-plugin-simple-import-sort";

export default [
    // generated data modules - not hand-written, don't lint
    { ignores: ["src/web-editor/functions/valueTables.js", "src/web-editor/functions/fxData.js"] },

    js.configs.recommended,

    {
        files: ["src/web-editor/**/*.js"],
        plugins: { "simple-import-sort": simpleImportSort },
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: "module",
            globals: globals.browser
        },
        rules: {
            // flag genuinely-unused locals/imports; ignore unused function args and
            // caught-error bindings (often intentional placeholders here)
            "no-unused-vars": ["error", { args: "none", caughtErrors: "none" }],
            "no-empty": ["error", { allowEmptyCatch: true }],
            // auto-sortable import/export ordering (statements grouped, members A–Z)
            "simple-import-sort/imports": "error",
            "simple-import-sort/exports": "error",
            // simple-import-sort sorts but doesn't format; this keeps the reordered
            // `{ a, b }` members space-separated (a deprecated core formatting rule;
            // move to @stylistic if a future ESLint removes it).
            "comma-spacing": ["error", { before: false, after: true }]
        }
    },

    // docs site scripts: small, dependency-free browser code loaded as a classic
    // <script> (not a module). Declare browser globals so document / window /
    // addEventListener resolve instead of tripping no-undef.
    {
        files: ["docs/**/*.js"],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: "script",
            globals: globals.browser
        }
    }
];
