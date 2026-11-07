// StrykerJS mutation baseline (job_30ab4e0e8702). Measurement only: not a gate,
// not in CI, and not a dependency. It is heavy (about four hours on 4 cores), so
// it runs locally in a quiet window, one heavy session at a time, in chunks:
// Stryker saves its incremental file only when a run finishes, so one long run
// that is interrupted loses everything, while a chunk loses at most itself.
//
//   npm i --no-save @stryker-mutator/core@10.0.0 @stryker-mutator/vitest-runner@10.0.0
//   for c in db audit admin content core rest; do STRYKER_CHUNK=$c npx stryker run; done
//   npm run report:mutation
//
// With no STRYKER_CHUNK it mutates everything in one run. Each chunk writes
// reports/mutation/<chunk>.json and its own incremental file (reports/ is
// ignored); `npm run report:mutation` (devkit-mutation-report) merges every JSON report it finds.
import { chunkedStryker } from "@dustinedwards/devkit/stryker";

const lib = (/** @type {string[]} */ ...dirs) => dirs.map((dir) => `app/lib/${dir}/**/*.ts`);

// `rest` is everything not named below: the remaining app/lib directories, app/lib/*.ts and workers/.
export default chunkedStryker({
  all: ["app/lib/**/*.ts", "app/db/**/*.ts", "workers/**/*.ts"],
  chunks: {
    db: ["app/db/**/*.ts"],
    audit: lib("decline-codes", "audit"),
    admin: lib("admin", "intelligence"),
    content: lib("blog", "recovery", "mcp"),
    core: lib("cron", "auth", "marketing", "webhooks", "compare", "seo", "billing"),
  },
  exclude: ["app/lib/demo/**"],
  vitestConfig: "vitest.stryker.config.ts",
});
