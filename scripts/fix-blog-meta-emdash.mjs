// Content-audit remediation (MEDIUM-4, foxhound-audit-content.md): a D1-wide
// scan (title/excerpt/og_title/og_description/body, plus a code-level grep
// of every route meta() export) found exactly one remaining em dash: the
// og_description on stripe-decline-codes, which is duplicated verbatim into
// <title>/<meta name="description">/og:description/JSON-LD description by
// app/routes/blog/post.tsx's meta() (it derives from post.ogDescription).
// Fixing the one D1 field fixes all four rendered surfaces at once; there is
// nothing to change in app/ itself (the standing no-em-dash rule already
// holds there except the compliance sanitizer's own detection regex).
//
// Usage:
//   node scripts/fix-blog-meta-emdash.mjs          # dry run
//   node scripts/fix-blog-meta-emdash.mjs --apply  # writes to D1, then re-verifies

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";

const APPLY = process.argv.includes("--apply");
const DB_NAME = "foxhound-production";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const WRANGLER_BIN = join(SCRIPT_DIR, "..", "node_modules", "wrangler", "bin", "wrangler.js");

function wrangler(args) {
  return execFileSync(process.execPath, [WRANGLER_BIN, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1024 * 1024 * 64,
  });
}

function d1Query(sql) {
  const out = wrangler(["d1", "execute", DB_NAME, "--remote", "--json", "--command", sql]);
  const start = out.indexOf("[");
  const parsed = JSON.parse(out.slice(start));
  return parsed[0]?.results ?? [];
}

function d1ExecuteFile(path) {
  wrangler(["d1", "execute", DB_NAME, "--remote", "--file", path]);
}

const SLUG = "stripe-decline-codes";
const BEFORE =
  "Every Stripe decline code explained — what it means, soft vs hard decline, retry strategy, and when to email the customer. With quick-reference table.";
const AFTER =
  "Every Stripe decline code explained: what it means, soft vs hard decline, retry strategy, and when to email the customer. With quick-reference table.";

function sqlValue(v) {
  return `'${String(v).replace(/'/g, "''")}'`;
}

async function main() {
  const rows = d1Query(`SELECT id, slug, og_description FROM blog_posts WHERE slug='${SLUG}';`);
  if (rows.length !== 1) {
    console.error(`ABORT: expected exactly 1 row for slug ${SLUG}, found ${rows.length}.`);
    process.exit(1);
  }
  const row = rows[0];
  if (row.og_description !== BEFORE) {
    console.error("ABORT: og_description does not match the expected before-text.");
    console.error(JSON.stringify(row.og_description));
    process.exit(1);
  }

  console.log(`\n=== Blog meta em-dash fix (${APPLY ? "apply" : "dry-run"}) ===`);
  console.log(`--- ${SLUG}.og_description ---`);
  console.log(`BEFORE: ${BEFORE}`);
  console.log(`AFTER:  ${AFTER}`);

  const logPath = join(SCRIPT_DIR, "blog-meta-emdash-fix-log.json");
  writeFileSync(logPath, JSON.stringify({ mode: APPLY ? "apply" : "dry-run", slug: SLUG, before: BEFORE, after: AFTER }, null, 2));
  console.log(`\nLog written to ${logPath}`);

  if (!APPLY) {
    console.log("\nDry run only. Re-run with --apply to write to D1.");
    return;
  }

  const sqlPath = join(SCRIPT_DIR, "out", "blog-meta-emdash-fix-apply.sql");
  writeFileSync(sqlPath, `UPDATE "blog_posts" SET "og_description"=${sqlValue(AFTER)} WHERE "id"='${row.id}';\n`);
  d1ExecuteFile(sqlPath);

  const after = d1Query(`SELECT og_description FROM blog_posts WHERE slug='${SLUG}';`);
  const ok = after[0]?.og_description === AFTER;
  console.log(ok ? "\nApply + verification OK." : "\nVERIFICATION FAILED.");
  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
