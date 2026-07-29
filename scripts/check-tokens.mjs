#!/usr/bin/env node
// Structural enforcement for DESIGN.md's two hard rules (task
// TASK-foxhound-design-system-port.md Part 1): no raw hex color outside the
// token file, no px font sizes anywhere. The old design system enforced its
// rules by a rulebook; this enforces them by build failure.
//
// This file is the CLI: it walks app/ and sets the exit code. The matchers
// themselves live in check-tokens-lib.mjs so they can be unit-tested against
// planted violations without running the walk.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { scanContent } from "./check-tokens-lib.mjs";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "assets") continue;
      walk(full, out);
    } else if (/\.(tsx?|css)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const files = walk(resolve(ROOT, "app"));
const violations = [];

for (const file of files) {
  const rel = file.slice(ROOT.length + 1).replace(/\\/g, "/");
  violations.push(...scanContent(rel, readFileSync(file, "utf8")));
}

if (violations.length > 0) {
  console.error(`check-tokens: ${violations.length} violation(s) found\n`);
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}

console.log("check-tokens: clean");
