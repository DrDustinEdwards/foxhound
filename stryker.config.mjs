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
import process from "node:process";

const ALL = ["app/lib/**/*.ts", "app/db/**/*.ts", "workers/**/*.ts"];
const lib = (...dirs) => dirs.map((dir) => `app/lib/${dir}/**/*.ts`);
const CHUNKS = {
  db: ["app/db/**/*.ts"],
  audit: lib("decline-codes", "audit"),
  admin: lib("admin", "intelligence"),
  content: lib("blog", "recovery", "mcp"),
  core: lib("cron", "auth", "marketing", "webhooks", "compare", "seo", "billing"),
};
// Everything not named above: the remaining app/lib directories, app/lib/*.ts
// and workers/.
CHUNKS.rest = [...ALL, ...Object.values(CHUNKS).flat().map((glob) => `!${glob}`)];

const chunk = process.env.STRYKER_CHUNK;
if (chunk && !CHUNKS[chunk]) {
  throw new Error(`Unknown STRYKER_CHUNK "${chunk}"; one of ${Object.keys(CHUNKS).join(", ")}`);
}
const name = chunk ?? "mutation";

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: "vitest",
  vitest: { configFile: "vitest.stryker.config.ts" },
  coverageAnalysis: "perTest",
  disableBail: true,
  incremental: true,
  incrementalFile: `reports/stryker-incremental-${name}.json`,
  mutate: [...(chunk ? CHUNKS[chunk] : ALL), "!app/lib/demo/**", "!**/*.d.ts"],
  ignoreStatic: true,
  reporters: ["json", "clear-text", "progress"],
  jsonReporter: { fileName: `reports/mutation/${name}.json` },
  concurrency: 4,
  timeoutMS: 30000,
  tempDirName: ".stryker-tmp",
};
