# Foxhound baseline (job_30ab4e0e8702)

First pass measured 2026-10-09 at commit 248ddcd (PR #24). Second pass, which
added Knip entry configuration, page weight per route, the assertion scan, the
StrykerJS run and the warn-only CI step, measured 2026-10-09 at commit a746383
(main). Linux container, 4 cores, Node 22. Nothing in the app changed and nothing
was deleted. This file is in the repo because the session may not write to
Capsid; move it to foxhound/baseline.md in Capsid.

## Commands and results

| What | Command | Result |
|------|---------|--------|
| Tests | `npx vitest run` | 255 files, 3,290 tests passed, about 80 s (the 2026-10-03 count of 3,006 is stale) |
| Test files and calls | `ls test/*.test.ts \| wc -l`; `npm run report:assertions` | 253 files in test/; 3,024 it/test declarations (it.each expands to more at run time) |
| Tests with no assertion | `npm run report:assertions` | 0 of 3,024. Verified by planting two assertion-free tests, both flagged |
| Lines of code | `npx cloc app workers scripts test drizzle --exclude-dir=node_modules,assets` | TypeScript 88,727 code lines (648 files), JSON 176,338 (33 files), JavaScript 2,300, SQL 1,117, CSS 653, Python 38 |
| Dependencies | package.json | 14 runtime, 25 dev (23 plus knip and jscpd, added by this job) |
| Duplication | `npm run report:duplication` (`.jscpd.json`) | 135 clones, 1,625 duplicated lines, 2.32% over 386 files |
| Dead code | `npm run report:knip` (`knip.json`, entries configured) | 2 unused files, 116 unused exports in 52 files, 84 unused exported types in 41 files, 1 unused devDependency, 1 unlisted dependency |
| Page weight per route | `npm run build && npm run report:page-weight` | 78 page routes; heaviest `/recovery/payments/:id` 145.3 kB gzip, median 128.2 kB, lightest `/u/:token` 123.7 kB. Budget 160 kB (warn only); 0 over |
| JS and CSS weight | `npm run build`, gzip of `build/client/assets` | 170 JS/CSS files, 1,083,274 B raw, 334,666 B gzip total |
| Worker bundle | same build | `server-build-*.js` 5,420 kB raw, 1,351 kB gzip |
| CI minutes per run | GitHub Actions run list for ci.yml, runs 377 to 388 | PR runs (verify only) 3.3 to 5.6 min wall; pushes to main (verify plus deploy) 6.4 to 7.0 min |
| Bloat report cost | `time npm run report:bloat` | about 7.5 s locally, so well under the one-minute ceiling the job sets |

### Knip with entries configured

`knip.json` names the one-off scripts and `app/lib/auth/generate.config.ts` as
entries and ignores the `cloudflare:workers` virtual module, which removes the
first pass's false positives (14 of its 16 "unused files").

- Unused files: `app/components/route-stub.tsx`, `app/lib/resource-stub.ts`.
- Unused devDependency: `cross-env` (no script uses it). `playwright` is no
  longer flagged: `scripts/viewport-harness.mjs` uses it.
- Unlisted dependency: `sharp`, imported by `scripts/build-icons.mjs` but not in
  package.json.
- Unused exports: mostly barrel re-exports in `app/lib/auth/index.ts` and
  `app/db/index.ts`, and constants exported but only used in their own module.
  Removing an export keyword is not deleting code, but it is a Part 2 change, not
  this one.

### Page weight

Every page loads the client entry and root (116.1 kB gzip of the total), so routes
differ by only about 22 kB. The heaviest are the signed-in app routes (app shell
plus settings). The full table is the output of `npm run report:page-weight`.

## Mutation testing (StrykerJS): partial, and why

Setup (`stryker.config.mjs`, `vitest.stryker.config.ts`): vitest runner,
`coverageAnalysis: perTest`, `disableBail: true`, `incremental: true`,
`ignoreStatic: true`, concurrency 4. Mutated: `app/lib/**`, `app/db/**`,
`workers/**`, excluding `app/lib/demo/**` and `.d.ts`. That gives 228 files and
17,299 mutants, of which 2,422 are static (ignored) and 14,877 count.

18 test files (32 tests) assert on the raw source text of app files. Stryker
rewrites mutated files, so those tests fail the initial run on unmutated code and
Stryker refuses to start. `vitest.stryker.config.ts` leaves them out of the
mutation run only, so a mutant only they would kill counts as survived. The
initial run then passes: 2,677 tests in about 3.5 minutes.

The run did not finish. The container was restarted twice (at about 19:23 and
20:59 UTC), and Stryker writes its incremental file only at the end of a run, so
both restarts lost the work in flight. What was recorded:

| Source | Tested | Killed + timeout | Survived | No coverage |
|--------|--------|------------------|----------|-------------|
| Saved incremental file (17:02) | 4,348 | 780 | 206 | 3,362 |
| Second run progress log (to 19:23) | 8,436 more | about 6,690 | 1,746 (17 timeouts) | 0 more |
| Total so far | 12,784 of 14,877 (86%) | about 7,470 | 1,952 | 3,362 |

Provisional reading, NOT the baseline:

- 3,362 of 14,877 mutants (22.6%) have no covering test at all. This number is
  complete: it comes from the per-test coverage of the full initial run.
- Of the covered mutants tested so far, about 79% are killed (79.1% in the saved
  file alone, 79.3% with the progress log). The 2,093 untested mutants are the
  files Stryker reached last, so the final number can move.
- `app/db/**` mutants run at about one a minute, because nearly every test
  touches the database layer and `disableBail` runs every covering test.

Not produced: the final mutation score and the per-test kill matrix. The kill
matrix needs every mutant in one merged report. The 17:02 file covers only a
slice, so its "zero-kill tests" count (2,359) is an artefact of that slice and
must not be used for pruning.

To finish on a quiet machine (one heavy session, nothing else building), in
chunks so an interruption loses at most one chunk:

```
npm i --no-save @stryker-mutator/core@10.0.0 @stryker-mutator/vitest-runner@10.0.0
for c in db audit admin content core rest; do STRYKER_CHUNK=$c npx stryker run; done
node scripts/report-mutation.mjs --json
```

`scripts/report-mutation.mjs` merges the chunk reports and prints the score,
zero-kill tests and tests whose kills are all covered by other tests. It marks
payment, money-path, Stripe webhook, auth, tenant-isolation and bug-fix tests as
protected; those are never candidates. Expect about four hours of wall time on 4
cores.

## Warn-only CI checks (Part 2a)

The `verify` job runs `npm run report:bloat` after Build: Knip, jscpd, page
weight against that build, and the assertion scan. Each exits 0 on a finding, and
the step is `continue-on-error`, so it reports and never blocks. Findings appear
as `::warning::` annotations (page weight over budget, tests with no assertion).
It adds about 8 seconds to a run. `test/ci-gate-parity.test.ts` declares it a
non-gate step.

## For the seat

1. Run the chunked Stryker baseline locally (commands above). Part 2b pruning
   waits on its kill matrix.
2. Decide on the Knip findings: the two stub files, `cross-env`, `sharp`, and the
   unused export keywords. Nothing was deleted here.
