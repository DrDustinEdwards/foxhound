// Perf-audit remediation (M-2, foxhound-audit-perf.md): migration 0009 added
// blog_posts.reading_minutes (default 1, a placeholder) so list/tag loaders
// never need to select the full body just to render a card's reading time.
// This backfills the real value for every existing post from its body word
// count, using the exact same formula as app/lib/blog/format.ts's
// estimateReadingTime (Math.max(1, Math.round(words / 200))), so historical
// posts read identically to how they always have. New/edited posts compute
// this at write time (createPost/updatePostWithVersion); this script is a
// one-time catch-up for the 45 rows that predate the column.
//
// Usage:
//   node scripts/backfill-blog-reading-minutes.mjs          # dry run
//   node scripts/backfill-blog-reading-minutes.mjs --apply  # writes to D1, then re-verifies

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";

const APPLY = process.argv.includes("--apply");
const DB_NAME = "foxhound";
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

// Exact port of app/lib/blog/format.ts's estimateReadingTime.
function estimateReadingTime(body) {
  const words = body.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}

async function main() {
  const rows = d1Query(`SELECT id, slug, body, reading_minutes FROM blog_posts ORDER BY slug;`);
  console.log(`Loaded ${rows.length} blog_posts rows from D1.`);

  const diffs = rows
    .map((r) => ({ id: r.id, slug: r.slug, before: r.reading_minutes, after: estimateReadingTime(r.body) }))
    .filter((d) => d.before !== d.after);

  console.log(`\n=== Blog reading_minutes backfill (${APPLY ? "apply" : "dry-run"}) ===`);
  console.log(`Rows scanned: ${rows.length}`);
  console.log(`Rows to change: ${diffs.length}`);
  for (const d of diffs) {
    console.log(`  ${d.slug}: ${d.before} -> ${d.after}`);
  }

  const logPath = join(SCRIPT_DIR, "blog-reading-minutes-backfill-log.json");
  writeFileSync(
    logPath,
    JSON.stringify(
      { mode: APPLY ? "apply" : "dry-run", rowsScanned: rows.length, preApplyDump: rows.map((r) => ({ id: r.id, slug: r.slug, readingMinutesBefore: r.reading_minutes })), diffs },
      null,
      2,
    ),
  );
  console.log(`\nLog written to ${logPath}`);

  if (!APPLY) {
    console.log("\nDry run only. Re-run with --apply to write to D1.");
    return;
  }

  if (diffs.length === 0) {
    console.log("Nothing to apply.");
    return;
  }

  const statements = diffs.map((d) => `UPDATE "blog_posts" SET "reading_minutes"=${d.after} WHERE "id"='${d.id}';`);
  const sqlPath = join(SCRIPT_DIR, "out", "blog-reading-minutes-backfill-apply.sql");
  writeFileSync(sqlPath, statements.join("\n") + "\n");
  d1ExecuteFile(sqlPath);

  const after = d1Query(`SELECT id, slug, body, reading_minutes FROM blog_posts ORDER BY slug;`);
  const mismatches = after.filter((r) => r.reading_minutes !== estimateReadingTime(r.body));
  console.log(`\nRemaining mismatches after apply (expect 0): ${mismatches.length}`);
  if (mismatches.length > 0) {
    console.error(JSON.stringify(mismatches.map((r) => r.slug)));
    console.error("VERIFICATION FAILED.");
    process.exit(1);
  }
  console.log("Apply + verification OK.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
