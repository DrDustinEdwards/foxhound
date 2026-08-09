#!/usr/bin/env node
// Meta-gate: asserts that `check:all` still chains at least MINIMUM_GATES gates.
//
// Why this exists: capsid/conventions.md records three enforcement mechanisms
// found silently passing inside eight days, all of which exited 0 on success AND
// on failure-to-check. A gate quietly dropped from the chain is the same defect
// one level up: `check:all` keeps exiting 0 while checking less than it used to.
// This counts the chain and fails if it shrinks.
//
// Raising MINIMUM_GATES is deliberate: add a gate, raise the number in the same
// commit, and the next person to delete one has to explain themselves.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Four gates run over the codebase; check-gates itself is excluded from the
// count because it checks the chain rather than the code. check-canon is NOT
// counted: it needs a canon export argument and cannot run unattended (see
// scripts/check-canon.mjs). Its MATCHERS are covered by the test gate.
const MINIMUM_GATES = 4;

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
const chain = pkg.scripts?.["check:all"];

if (typeof chain !== "string" || chain.trim() === "") {
  console.error("check-gates: package.json has no `check:all` script. Refusing to pass.");
  process.exit(1);
}

// Count invocations, not `&&`s: a gate that runs two commands is still one gate,
// and counting separators would drift from what is actually enforced.
const gates = chain
  .split("&&")
  .map((s) => s.trim())
  .filter((s) => s.length > 0 && s !== "npm run check-gates" && !s.endsWith("check-gates"));

if (gates.length < MINIMUM_GATES) {
  console.error(
    `check-gates: check:all runs ${gates.length} gate(s), minimum is ${MINIMUM_GATES}.\n` +
      `  A gate was removed without lowering the minimum deliberately.\n` +
      `  Chain: ${gates.join(" | ")}`,
  );
  process.exit(1);
}

console.log(`check-gates: ${gates.length} gates wired (minimum ${MINIMUM_GATES}): ${gates.join(", ")}`);
