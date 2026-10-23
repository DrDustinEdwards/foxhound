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

## Mutation testing (StrykerJS): final baseline (job_c138c07f35fb)

Finished 2026-10-10 at commit d04f134 (main), by running the six chunks of
`stryker.config.mjs` one at a time with incremental mode on, then merging them
with `npm run report:mutation`. Each chunk's mutation JSON and
incremental file were pushed to the branch `results/foxhound-mutation-baseline`
(`chunks/`) as soon as the chunk finished, so a restart loses at most one chunk.

Setup: vitest runner, `coverageAnalysis: perTest`, `disableBail: true`,
`ignoreStatic: true`, concurrency 4. Mutated: `app/lib/**`, `app/db/**`,
`workers/**`, excluding `app/lib/demo/**` and `.d.ts`. That is 228 files and
17,299 mutants, of which 2,422 are static (ignored) and 14,877 count.

18 test files (32 tests) assert on the raw source text of app files, which
Stryker's rewriting breaks, so `vitest.stryker.config.ts` leaves them out of the
mutation run. A mutant only they would kill counts as survived here, and they are
not in the kill matrix.

### Score

| Status | Mutants |
|--------|---------|
| Killed | 8,150 |
| Timeout (counted as killed) | 20 |
| Survived | 3,345 |
| No coverage | 3,362 |
| Ignored (static) | 2,422 |
| Valid (killed + survived + no coverage) | 14,877 |

- **Mutation score: 54.92%** (8,170 of 14,877).
- Score over covered code: 70.95% (8,170 of 11,515).
- 22.6% of mutants have no covering test at all.
- The earlier provisional reading (about 79% of covered mutants killed) was too
  high: the files Stryker reached last were the weaker ones.

### Per-test kill matrix

2,677 tests, keyed by file and test name. The full matrix (per test: kills,
unique kills, candidate kind, protected flag) is `docs/research/kill-matrix.json`.
The raw chunk reports are on the results branch.

| Group | Tests | Of which protected |
|-------|-------|--------------------|
| Zero-kill (kills no mutant) | 588 | 394 |
| Covered by others (every kill is also made by another test) | 1,354 | 762 |
| Unprotected zero-kill candidates | 194 | |
| Unprotected covered-by-others candidates | 592 | |

Protected means the file or test name matches the keep rule (`--protected`) in
the `report:mutation` script in `package.json`: payment, billing, money, Stripe, webhook, dispute,
auth, session, tenant isolation, account scope, role and admin guards, and tests
written for a fixed bug. The match is a name heuristic that errs toward keeping.
These are never removal candidates.

### Removal candidates (nothing removed)

786 unprotected tests in 118 files (194 zero-kill, 592 covered by others). 15 of
those files have every test flagged. The 40 files with the most candidates:

| Test file | Tests | Zero-kill | Covered by others |
|---|---|---|---|
| test/admin-brake.test.ts | 37 | 2 | 27 |
| test/cache-no-transform.test.ts | 30 | 1 | 22 |
| test/audit-monthly-362.test.ts | 47 | 0 | 22 |
| test/bulk-actions.test.ts | 42 | 8 | 12 |
| test/help-sections-399.test.ts | 23 | 3 | 16 |
| test/rate-limit.test.ts | 38 | 0 | 19 |
| test/s7-remainder-six.test.ts | 22 | 16 | 1 |
| test/retention-bound-params-317.test.ts | 26 | 4 | 13 |
| test/multi-account-switcher-phase-e.test.ts | 27 | 12 | 5 |
| test/roving-index.test.ts | 19 | 0 | 15 |
| test/manual-action-dispatch.test.ts | 48 | 0 | 14 |
| test/recovery-generation-fallback.test.ts | 14 | 0 | 14 |
| test/demo-email-copy.test.ts | 14 | 2 | 11 |
| test/settings-audit-315.test.ts | 17 | 6 | 7 |
| test/intelligence-signals.test.ts | 37 | 0 | 12 |
| test/scanner-phase-one-377.test.ts | 15 | 1 | 11 |
| test/s6-stat-card-treatment.test.ts | 16 | 6 | 6 |
| test/bulk-selection.test.ts | 18 | 7 | 5 |
| test/recovery-schedule.test.ts | 15 | 1 | 11 |
| test/error-view-withdrawn-394.test.ts | 12 | 2 | 10 |
| test/observability-313.test.ts | 24 | 1 | 10 |
| test/recovery-dashboard-queries.test.ts | 18 | 0 | 10 |
| test/cron-recovery-tick.test.ts | 22 | 2 | 8 |
| test/route-splash-305.test.ts | 16 | 5 | 5 |
| test/queue-consumer-parity-376.test.ts | 10 | 10 | 0 |
| test/recovery-dashboard-display.test.ts | 11 | 6 | 4 |
| test/admin-cron-enable-confirm.test.ts | 10 | 0 | 9 |
| test/demo-intelligence-seed.test.ts | 12 | 3 | 6 |
| test/cron-registry.test.ts | 10 | 5 | 4 |
| test/recovery-email-generation.test.ts | 14 | 0 | 9 |
| test/marketing-nav.test.ts | 10 | 9 | 0 |
| test/intelligence-mrr.test.ts | 17 | 0 | 8 |
| test/recovery-email-template.test.ts | 15 | 1 | 7 |
| test/recovery-engine.test.ts | 15 | 0 | 8 |
| test/constants-chunks-17.test.ts | 8 | 6 | 2 |
| test/redirect-map.test.ts | 11 | 8 | 0 |
| test/dashboard-console.test.ts | 32 | 0 | 7 |
| test/cron-exhausted-sequences.test.ts | 13 | 0 | 7 |
| test/mrr-movement-chart-399.test.ts | 7 | 0 | 7 |
| test/churn-chart-repair-398.test.ts | 7 | 0 | 7 |

How to read this before any pruning job uses it:

- Candidates are per test, not joint. Two tests that only cover each other are
  both flagged, and removing both loses kills. A pruning step must re-run
  Stryker (or at least re-check the matrix) after each batch.
- A zero-kill test is not worthless. It may assert behavior on code Stryker does
  not mutate (routes, components, config), on a mutant it ignores as static, or
  on the 22.6% of code with no mutants covered. Check what the test protects
  before cutting.
- The 18 source-text test files are outside the matrix and were not assessed.
- Survived mutants (3,345) point the other way: they show behavior no test pins.
  Adding tests there is worth more than trimming.

Nothing was deleted or changed in the app or the tests.

## Warn-only CI checks (Part 2a)

The `verify` job runs `npm run report:bloat` after Build: Knip, jscpd, page
weight against that build, and the assertion scan. Each exits 0 on a finding, and
the step is `continue-on-error`, so it reports and never blocks. Findings appear
as `::warning::` annotations (page weight over budget, tests with no assertion).
It adds about 8 seconds to a run.

## For the seat

1. The mutation baseline and kill matrix are done (section above). Part 2b
   pruning can start from the candidate list, one batch at a time, re-checking
   after each.
2. Decide on the Knip findings: the two stub files, `cross-env`, `sharp`, and the
   unused export keywords. Nothing was deleted here.
