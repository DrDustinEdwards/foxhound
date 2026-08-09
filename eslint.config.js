import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["build/", ".react-router/", ".wrangler/", "worker-configuration.d.ts"],
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
