import { defineConfig } from "oxlint";
import { base, react, node } from "@dustinedwards/devkit/oxlint";

export default defineConfig({
  extends: [base, react],
  rules: {
    // off in devkit 0.24.0
    "typescript/no-non-null-assertion": "off",
    // off in devkit 0.24.0
    "react/only-export-components": "off",
    // off in devkit 0.24.0
    "jsx-a11y/prefer-tag-over-role": "off",
    // off in devkit 0.24.0
    "jsx-a11y/control-has-associated-label": "off",
    // off in devkit 0.24.0
    "jsx-a11y/media-has-caption": "off",
  },
  ignorePatterns: [
    // devkit's base ignores, which Oxlint 1.92 does not carry through `extends` (devkit 0.24.0 exports them).
    "build/",
    "dist/",
    ".react-router/",
    ".wrangler/",
    "worker-configuration.d.ts",
    "**/*.gen.ts",
    // StrykerJS's sandbox and output (stryker.config.mjs): an interrupted run leaves an instrumented copy of the repo.
    ".stryker-tmp/",
    "reports/",
  ],
  overrides: [{ files: ["scripts/**", "bin/**", "test/**"], ...node }],
});
