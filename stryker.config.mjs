// StrykerJS mutation baseline (job_30ab4e0e8702). Measurement only: not a gate,
// not in CI, and not a dependency. It is heavy (hours), so it runs locally in a
// quiet window, one heavy session at a time. Run with:
//   npm i --no-save @stryker-mutator/core@10.0.0 @stryker-mutator/vitest-runner@10.0.0
//   npx stryker run
// Results land in reports/mutation/ (ignored); docs/research/baseline.md records them.
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: "vitest",
  vitest: { configFile: "vitest.stryker.config.ts" },
  coverageAnalysis: "perTest",
  disableBail: true,
  incremental: true,
  incrementalFile: "reports/stryker-incremental.json",
  mutate: [
    "app/lib/**/*.ts",
    "app/db/**/*.ts",
    "workers/**/*.ts",
    "!app/lib/demo/**",
    "!**/*.d.ts",
  ],
  ignoreStatic: true,
  reporters: ["json", "clear-text", "progress"],
  jsonReporter: { fileName: "reports/mutation/mutation.json" },
  concurrency: 4,
  timeoutMS: 30000,
  tempDirName: ".stryker-tmp",
};
