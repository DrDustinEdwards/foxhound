#!/usr/bin/env node
// Warn-only check: tests with no assertion (job_30ab4e0e8702, no-bloat plan).
//
// A test whose body never calls expect or assert passes whatever the code does,
// unless it asserts through a helper. This walks every test file's syntax tree
// (the TypeScript compiler API, already a dependency), finds each it/test call,
// and flags a callback that contains no `expect`, `assert` or `expectTypeOf`
// call and no call to a function whose name starts with `expect` or `assert`
// (the repo's own assertion helpers). It also flags an empty callback.
//
// It REPORTS and never blocks: exit 0, with a GitHub `::warning::` per test so
// the list shows on the PR. A flagged test that asserts through a differently
// named helper is a false positive; rename the helper `expect...`/`assert...`
// or read it as a hint.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const TEST_DIR = resolve(ROOT, "test");

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.test\.(ts|tsx|mjs|js)$/.test(name)) out.push(full);
  }
  return out;
}

const TEST_FNS = new Set(["it", "test"]);
// Modifiers that still run (or declare) a test body. skip/todo are left out:
// a skipped test is a different finding, and todo has no body.
const RUNNING_MODIFIERS = new Set(["only", "concurrent", "sequential", "fails", "each", "for", "runIf"]);

/** True when `expr` names it/test, possibly through modifiers: it.only, it.each(table), test.concurrent. */
function isTestCallee(expr) {
  if (ts.isIdentifier(expr)) return TEST_FNS.has(expr.text);
  if (ts.isPropertyAccessExpression(expr)) {
    return RUNNING_MODIFIERS.has(expr.name.text) && isTestCallee(expr.expression);
  }
  // it.each(table)(name, fn) and it.runIf(cond)(name, fn)
  if (ts.isCallExpression(expr)) return isTestCallee(expr.expression);
  return false;
}

function calleeName(expr) {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return calleeName(expr.expression);
  if (ts.isCallExpression(expr)) return calleeName(expr.expression);
  return "";
}

function asserts(node) {
  let found = false;
  const visit = (child) => {
    if (found) return;
    if (ts.isCallExpression(child)) {
      const name = calleeName(child.expression);
      if (/^(expect|assert)/.test(name)) {
        found = true;
        return;
      }
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

const findings = [];
let total = 0;
for (const file of walk(TEST_DIR)) {
  const text = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const visit = (node) => {
    if (ts.isCallExpression(node) && isTestCallee(node.expression)) {
      const fn = node.arguments.find((arg) => ts.isArrowFunction(arg) || ts.isFunctionExpression(arg));
      if (fn) {
        total += 1;
        if (!asserts(fn.body)) {
          const name = node.arguments[0] && ts.isStringLiteralLike(node.arguments[0]) ? node.arguments[0].text : "(unnamed)";
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          findings.push({ file: relative(ROOT, file), line: line + 1, name });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

for (const finding of findings) {
  console.log(
    `::warning file=${finding.file},line=${finding.line},title=Test with no assertion::${finding.name}`,
  );
}
console.log(`\n${total} test declarations scanned; ${findings.length} with no assertion (warn only).`);
