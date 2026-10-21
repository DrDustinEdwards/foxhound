#!/usr/bin/env node
// Canon integrity sweep (ruling 100), mechanised by ruling 192.
//
// WHY THIS EXISTS AS A GATE AND NOT A JOB: this sweep was deferred four
// consecutive sessions across three different prompt orderings. It is the only
// recurring item in the parity campaign with no deadline and no dependent, so
// anything real outranks it and every session finds something real. Ruling 192:
// a recurring check that depends on someone CHOOSING to run it will lose to
// real work forever. The remedy is mechanisation, not priority.
//
// WHAT IT CANNOT DO, STATED LOUDLY RATHER THAN PAPERED OVER:
// canon lives in Capsid (namespace `foxhound`), not in this repo, and CLAUDE.md
// forbids mirroring canon content back into the tree (the repo copies drifted
// once already). So this script
// cannot reach canon by itself. It takes an EXPORT directory and refuses to run
// without one. That makes the sweep one command instead of a manual procedure;
// it does not make it a zero-touch CI gate, and pretending otherwise would be
// ruling 122's silent skip wearing a green tick.
//
//   node scripts/check-canon.mjs --canon <dir> [--entry <path>]
//
// <dir> mirrors canon paths, e.g. <dir>/parity/DECISIONS.md.
// --entry defaults to CLAUDE.md, the document an AGENT actually reads first
// (ruling 191), NOT parity/DECISIONS.md, which is where a reader of canon starts.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

import {
  commitChainCheck,
  forwardCheck,
  guardNonEmpty,
  inverseCheck,
  ledgerCheck,
} from "./check-canon-lib.mjs";

const LEDGER_INDEX = "parity/PARITY-ROWS.md";

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : process.argv[i + 1] ?? null;
}

const canonDir = arg("--canon");
const entryPoint = arg("--entry") ?? "CLAUDE.md";

if (!canonDir) {
  console.error(
    "check-canon: no --canon <dir> supplied.\n" +
      "  Canon lives in Capsid, not this repo. Export it first, then point this\n" +
      "  script at the export. Refusing to run rather than reporting clean over\n" +
      "  nothing (ruling 122).",
  );
  process.exit(2);
}

let root;
try {
  root = resolve(canonDir);
  if (!statSync(root).isDirectory()) throw new Error("not a directory");
} catch {
  console.error(`check-canon: --canon ${canonDir} is not a readable directory. Refusing to run.`);
  process.exit(2);
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".md")) out.push(full);
  }
  return out;
}

const docs = new Map();
for (const file of walk(root)) {
  const rel = file.slice(root.length + 1).replace(/\\/g, "/");
  docs.set(rel, readFileSync(file, "utf8"));
}

const resolvesSha = (sha) => {
  try {
    // Quoted: `^{commit}` is a script block to PowerShell. Git Bash is fine,
    // execFileSync bypasses the shell entirely, but the quoting stays as
    // documentation of the hazard (capsid/conventions.md).
    execFileSync("git", ["cat-file", "-e", `${sha}^{commit}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

const violations = [];
violations.push(...guardNonEmpty(docs));

const forward = forwardCheck(docs);
violations.push(...forward.violations);

const inverse = inverseCheck(docs, entryPoint);
violations.push(...inverse.violations);

const ledger = ledgerCheck(docs, LEDGER_INDEX);
violations.push(...ledger.violations);

const chain = commitChainCheck(docs, resolvesSha);
violations.push(...chain.violations);

console.log(
  `check-canon: ${docs.size} documents; ` +
    `${forward.citedCount} citations checked; ` +
    `${inverse.reachedCount} reachable from ${entryPoint}; ` +
    `${ledger.counted} rows counted against ${ledger.declared ?? "no"} declared; ` +
    `${chain.checked} shas checked.`,
);

if (violations.length > 0) {
  console.error(`\ncheck-canon: ${violations.length} violation(s) found\n`);
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}

console.log("check-canon: clean");
