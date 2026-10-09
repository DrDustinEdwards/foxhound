#!/usr/bin/env node
// Summarise a StrykerJS run (job_30ab4e0e8702). Measurement only: it reads
// every reports/mutation/*.json (one per chunk, or mutation.json for a single
// run, written by `npx stryker run`, see stryker.config.mjs), merges them, and
// prints the mutation score, the per-test kill matrix
// summary and the pruning CANDIDATES the job defines. It deletes nothing and
// decides nothing; the seat reads the list.
//
// Candidates:
//   - zero-kill: a test that kills no mutant.
//   - covered: every mutant the test kills is also killed by some other test.
//     This is per test, not jointly: two tests that only cover each other both
//     show up, and removing both would lose kills. A pruning step must re-check.
// Protected (always kept, per the job): payment, money-path, Stripe webhook,
// auth and tenant-isolation tests, and tests written for a fixed bug. Matched
// by file name and test name below; a heuristic, so it errs toward keeping.
//
// Pass --json to write reports/mutation/kill-matrix.json (per test: file, name,
// kills, unique kills, candidate kind, protected).
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const DIR = resolve(ROOT, "reports/mutation");
const reports = readdirSync(DIR)
  .filter((name) => name.endsWith(".json") && name !== "kill-matrix.json")
  .map((name) => JSON.parse(readFileSync(resolve(DIR, name), "utf8")));
if (reports.length === 0) {
  console.error("report-mutation: no reports/mutation/*.json. Run Stryker first (stryker.config.mjs).");
  process.exit(1);
}

const PROTECTED =
  /billing|billable|money|payment|charge|invoice|refund|credit|fee|stripe|webhook|dispute|auth|session|tenant|isolation|account-scope|cross-account|member|role|admin-route-guard|fix|bug|regression|seen red|plant/i;

// Test ids are per run, so across chunks a test is keyed by file and name.
const tests = new Map();
const counts = {};
const killers = new Map();
for (const report of reports) {
  const keyOf = new Map();
  for (const [file, entry] of Object.entries(report.testFiles ?? {})) {
    for (const test of entry.tests ?? []) {
      const key = `${file}::${test.name}`;
      keyOf.set(test.id, key);
      if (!tests.has(key)) tests.set(key, { file, name: test.name, kills: new Set() });
    }
  }
  for (const [file, entry] of Object.entries(report.files ?? {})) {
    for (const mutant of entry.mutants ?? []) {
      counts[mutant.status] = (counts[mutant.status] ?? 0) + 1;
      const key = `${file}#${mutant.id}`;
      const by = mutant.killedBy ?? [];
      killers.set(key, by.length);
      for (const id of by) tests.get(keyOf.get(id))?.kills.add(key);
    }
  }
}

const killed = (counts.Killed ?? 0) + (counts.Timeout ?? 0);
const survived = counts.Survived ?? 0;
const noCoverage = counts.NoCoverage ?? 0;
const valid = killed + survived + noCoverage;
const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(2)}%` : "n/a");

const rows = [];
for (const test of tests.values()) {
  let unique = 0;
  for (const key of test.kills) if (killers.get(key) === 1) unique += 1;
  const isProtected = PROTECTED.test(test.file) || PROTECTED.test(test.name);
  const kind = test.kills.size === 0 ? "zero-kill" : unique === 0 ? "covered" : "";
  rows.push({ file: test.file, name: test.name, kills: test.kills.size, unique, kind, protected: isProtected });
}

const zero = rows.filter((r) => r.kind === "zero-kill");
const covered = rows.filter((r) => r.kind === "covered");
console.log(`Reports merged: ${reports.length}`);
console.log("Mutant status counts:", counts);
console.log(`Mutation score (killed+timeout over all valid): ${pct(killed, valid)}`);
console.log(`Mutation score over covered code: ${pct(killed, killed + survived)}`);
console.log(`Tests in the kill matrix: ${rows.length}`);
console.log(`Zero-kill tests: ${zero.length} (${zero.filter((r) => r.protected).length} protected)`);
console.log(`Covered-by-others tests: ${covered.length} (${covered.filter((r) => r.protected).length} protected)`);
console.log(
  `Unprotected candidates: ${zero.filter((r) => !r.protected).length} zero-kill, ${covered.filter((r) => !r.protected).length} covered`,
);

if (process.argv.includes("--json")) {
  mkdirSync(resolve(ROOT, "reports/mutation"), { recursive: true });
  writeFileSync(resolve(ROOT, "reports/mutation/kill-matrix.json"), JSON.stringify(rows, null, 2));
  console.log("Wrote reports/mutation/kill-matrix.json");
}
