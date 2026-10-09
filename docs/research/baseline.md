# Foxhound baseline (job_30ab4e0e8702, Part 1: measure only)

Measured 2026-10-09 at commit 248ddcd (main), Linux container. Nothing in the
app changed. This file is in the repo because the session may not write to
Capsid; move it to foxhound/baseline.md in Capsid.

## Not measured, and why

StrykerJS (mutation score, per-test kill matrix) was NOT run. With 253 test files
and about 3,290 tests (a full vitest run takes about 80 s here), a mutation run
across 88,727 lines of TypeScript is many hours and belongs in the "one heavy
session, nothing else building" window the job names. Part 2's pruning depends
on it, so it is the first thing to approve. Suggested setup for a quiet local
machine: `testRunner: vitest`, `coverageAnalysis: perTest`, `disableBail: true`,
`incremental: true`, mutate scoped to `app/lib/**` and `workers/**`, excluding
tests and `app/lib/demo/**`.

## Commands and results

| What | Command | Result |
|------|---------|--------|
| Tests | `npx vitest run` | 255 files, 3,290 tests passed, about 80 s (the 2026-10-03 count of 3,006 is stale) |
| Test files and calls | `ls test/*.test.ts \| wc -l`; grep of `it(`/`test(` | 253 files in test/, about 2,970 literal calls (the rest come from `it.each`) |
| Lines of code | `npx cloc app workers scripts test drizzle --exclude-dir=node_modules,assets` | TypeScript 88,727 code lines (648 files), JSON 176,338 (33 files), JavaScript 2,300, SQL 1,117, CSS 653, Python 38 |
| Dependencies | package.json | 14 runtime, 23 dev |
| Duplication | `npx jscpd app workers --format typescript,tsx --ignore "**/*.test.*,**/*.d.ts"` | 135 clones, 1,625 duplicated lines, 2.33% over 384 files |
| Dead code | `npx knip --reporter json` (default config, no framework entry tuning) | 16 unused files, 117 unused exports, 84 unused exported types, 3 unlisted deps, 2 unused devDependencies, 1 unlisted binary |
| JS and CSS weight | `npm run build`, gzip of `build/client/assets` | 170 JS/CSS files, 1,083,274 B raw, 334,666 B gzip total |
| Worker bundle | same build | `server-build-*.js` 5,420 kB raw, 1,351 kB gzip |
| CI minutes per run | GitHub Actions run list for ci.yml | about 4.5 to 5.6 minutes wall per run (runs 372 to 377); each PR run costs that, and a push to main runs it again |

### Knip: what it found (first pass, treat as candidates)

Unused files: 13 one-off `scripts/*.mjs` (backfill-blog-*, fix-blog-*,
fix-recova-brand*, transform-legacy-to-staging, build-icons, improve-report,
measure-*, viewport-harness), `app/components/route-stub.tsx`,
`app/lib/resource-stub.ts`, and `app/lib/auth/generate.config.ts` (used by the
`auth:generate` script, so a false positive until Knip is given that entry).
Unlisted: `cloudflare` (the `cloudflare:workers` virtual module, a false
positive). Unused devDependencies: `cross-env`, `playwright` (playwright is used
by the measure scripts only). The export lists are long mainly because many
exports are used only by tests, or are types; they need entry configuration
before they are trusted.

### Heaviest client files (gzip)

entry.client 57.9 kB, jsx-runtime 27.6 kB, index 13.2 kB, demo-guarded-form
13.0 kB, root.css 11.8 kB, errorBoundaries 11.6 kB, home route 9.4 kB, terms
route 8.7 kB. A per-route table needs the React Router build manifest and is a
Part 2 item.

## For the seat

1. Approve a local Stryker run to get the mutation baseline.
2. Approve warn-only CI checks (Knip with a React Router entry config, jscpd,
   page weight). Each should add well under a minute to a roughly 5 minute run.
3. The 13 unused scripts are Part 2 candidates; nothing was deleted here.
