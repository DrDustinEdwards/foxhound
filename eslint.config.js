import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // .stryker-tmp/ and reports/ are StrykerJS sandboxes and output (stryker.config.mjs);
    // a run that is interrupted leaves an instrumented copy of the repo behind.
    ignores: ["build/", ".react-router/", ".wrangler/", "worker-configuration.d.ts", ".stryker-tmp/", "reports/"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  reactHooks.configs.flat["recommended-latest"],
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.worker,
      },
    },
  },
  {
    // Workers Best Practices: "Do not leave promises floating". A dropped
    // promise is a swallowed error or a task cut off at response end.
    // Type-aware, so scoped to app and workers source (tests excluded).
    files: ["app/**/*.{ts,tsx}", "workers/**/*.ts"],
    ignores: ["**/*.test.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
    },
  },
  {
    // Build and check scripts are Node, not Worker. Without this they lint as
    // browser code and every `process.exit` in a gate reads as an undefined
    // global, which is why `eslint .` was already red on main before check:all
    // existed to notice.
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
);
