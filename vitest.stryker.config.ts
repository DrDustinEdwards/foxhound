// Vitest config for the StrykerJS mutation baseline only (stryker.config.mjs).
// Never used by `npm test` or CI.
//
// These files assert on the raw source text of app files (readFileSync of a
// .ts file, then toContain). Stryker rewrites every mutated file, so they fail
// the initial run on unmutated code and Stryker refuses to start. They are left
// out of the mutation run, so a mutant only they would kill counts as survived;
// docs/research/baseline.md records the list and that caveat.
import { configDefaults, defineConfig, mergeConfig } from "vitest/config";

import base from "./vitest.config";

const SOURCE_TEXT_TEST_FILES = [
  "test/ai-gateway-client.test.ts",
  "test/cache-policy.test.ts",
  "test/d1-backup-job-f7f35d4b7ac7.test.ts",
  "test/expiring-card-cron.test.ts",
  "test/live-send-flag.test.ts",
  "test/merchant-recovery-notification.test.ts",
  "test/multi-account-phase-b-327.test.ts",
  "test/sentry-noop-372.test.ts",
  "test/sequence-complete-notification.test.ts",
  "test/settings-digest-email-removed.test.ts",
  "test/settings-email-s33.test.ts",
  "test/settings-stripe-s37.test.ts",
  "test/winback-creation.test.ts",
  "test/winback-gate-and-stop.test.ts",
];

export default mergeConfig(
  base,
  defineConfig({
    test: { exclude: [...configDefaults.exclude, ...SOURCE_TEXT_TEST_FILES] },
  }),
);
