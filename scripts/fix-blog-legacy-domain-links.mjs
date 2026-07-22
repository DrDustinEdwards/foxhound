// Content-audit remediation (HIGH-3, foxhound-audit-content.md): a handful
// of blog posts still link out to the legacy recovamrr.com domain instead
// of the site's own /audit route. Mechanical, idempotent: replaces both the
// markdown-link form (https://recovamrr.com/audit) and the bare-text form
// (recovamrr.com/audit) with the relative /audit path, in blog_posts.body
// only. Case-sensitive-enough by construction (the pattern is the literal
// hostname), no suspect-match guard needed the way the brand-token swap
// script has one, since "/audit" cannot collide with adjacent prose the way
// a bare word like "Recova" can.
//
// Usage:
//   node scripts/fix-blog-legacy-domain-links.mjs          # dry run
//   node scripts/fix-blog-legacy-domain-links.mjs --apply  # writes to D1, then re-verifies

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";

const APPLY = process.argv.includes("--apply");
const DB_NAME = "foxhound-staging";
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

function fixLinks(body) {
  return body
    .replace(/https:\/\/recovamrr\.com\/audit/g, "/audit")
    .replace(/(?<!\/)recovamrr\.com\/audit/g, "/audit");
}

function sqlValue(v) {
  return `'${String(v).replace(/'/g, "''")}'`;
}

async function main() {
  const rows = d1Query(`SELECT id, slug, body FROM blog_posts WHERE body LIKE '%recovamrr.com%';`);
  console.log(`Posts with recovamrr.com in body: ${rows.length}`);

  const diffs = [];
  for (const row of rows) {
    const fixed = fixLinks(row.body);
    if (fixed === row.body) continue;
    const before = [...row.body.matchAll(/.{0,40}recovamrr\.com[^\s)]*.{0,10}/g)].map((m) => m[0]);
    diffs.push({ id: row.id, slug: row.slug, occurrences: before.length, before, newBody: fixed });
  }

  console.log(`\n=== Blog legacy-domain link sweep (${APPLY ? "apply" : "dry-run"}) ===`);
  for (const d of diffs) {
    console.log(`\n--- ${d.slug} (${d.occurrences} occurrence(s)) ---`);
    for (const b of d.before) console.log(`  ${JSON.stringify(b)}`);
  }

  const logPath = join(SCRIPT_DIR, "blog-legacy-domain-link-sweep-log.json");
  writeFileSync(
    logPath,
    JSON.stringify(
      { mode: APPLY ? "apply" : "dry-run", diffs: diffs.map((d) => ({ slug: d.slug, occurrences: d.occurrences, before: d.before })) },
      null,
      2,
    ),
  );
  console.log(`\nLog written to ${logPath}`);

  if (!APPLY) {
    console.log("\nDry run only. Re-run with --apply to write to D1.");
    return;
  }

  const statements = diffs.map((d) => `UPDATE "blog_posts" SET "body"=${sqlValue(d.newBody)} WHERE "id"='${d.id}';`);
  const sqlPath = join(SCRIPT_DIR, "out", "blog-legacy-domain-link-sweep-apply.sql");
  writeFileSync(sqlPath, statements.join("\n") + "\n");
  if (statements.length > 0) d1ExecuteFile(sqlPath);

  const remaining = d1Query(`SELECT COUNT(*) as cnt FROM blog_posts WHERE body LIKE '%recovamrr.com%';`);
  const remainingCount = remaining[0]?.cnt ?? -1;
  console.log(`\nRemaining recovamrr.com occurrences in blog_posts.body (expect 0): ${remainingCount}`);
  if (remainingCount !== 0) {
    console.error("VERIFICATION FAILED.");
    process.exit(1);
  }
  console.log("Apply + verification OK.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
