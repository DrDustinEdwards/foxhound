import { defineConfig } from "oxlint";
import { base, react, node, ignorePatterns } from "@dustinedwards/devkit/oxlint";

export default defineConfig({
  extends: [base, react],
  ignorePatterns: [
    ...ignorePatterns,
    // StrykerJS's sandbox and output (stryker.config.mjs): an interrupted run leaves an instrumented copy of the repo.
    ".stryker-tmp/",
    "reports/",
  ],
  overrides: [{ files: ["scripts/**", "bin/**", "test/**"], ...node }],
});
