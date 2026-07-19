// Follow-up to fix-recova-brand.mjs: the first pass (author/title/excerpt/
// body) deliberately excluded og_title/og_description per that pass's exact
// scope, but those two fields still carried "Recova" into 5 posts' <title>
// tag and JSON-LD headline (post.tsx renders `post.ogTitle ?? post.title`).
// Same idempotent token-swap method, DISTINCT log path (the previous pass
// lost its apply-time log to a confirmatory dry-run overwriting the same
// file; this script never writes its log twice, see the tail of main()).
//
// Usage:
//   node scripts/fix-recova-brand-og.mjs              # dry run only
//   node scripts/fix-recova-brand-og.mjs --apply       # applies, then verifies

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";

const APPLY = process.argv.includes("--apply");
const DB_NAME = "foxhound-staging";
const FIELDS = ["og_title", "og_description"];

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const LOG_PATH = join(SCRIPT_DIR, "recova-brand-swap-og-log.json");
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

function swapBrand(value) {
  if (value === null || value === undefined) return value;
  let out = value.replace(/Recova's/g, "Foxhound's");
  out = out.replace(/\bRecova\b/g, "Foxhound");
  return out;
}

function findSuspectMatches(original) {
  const suspects = [];
  const re = /Recova(?:'s)?/g;
  let m;
  while ((m = re.exec(original ?? "")) !== null) {
    const before = original.slice(Math.max(0, m.index - 40), m.index);
    const after = original.slice(m.index, m.index + 40);
    if (/https?:\/\/\S*$/.test(before) || /^\S*\.(com|org|net|io)/.test(after) || /^-[a-z]/.test(after)) {
      suspects.push({ index: m.index, before, after });
    }
  }
  return suspects;
}

function occurrences(value) {
  if (!value) return 0;
  const m = value.match(/Recova(?:'s)?/g);
  return m ? m.length : 0;
}

function sqlValue(v) {
  if (v === null || v === undefined) return "NULL";
  return `'${String(v).replace(/'/g, "''")}'`;
}

async function main() {
  const rows = d1Query(`SELECT id, slug, og_title, og_description FROM blog_posts ORDER BY slug`);
  console.log(`Loaded ${rows.length} blog_posts rows from D1.`);
  const slugsBefore = rows.map((r) => r.slug).sort();

  const diffs = [];
  const allSuspects = [];
  const totals = { og_title: 0, og_description: 0 };

  for (const row of rows) {
    const fieldDiffs = {};
    let touched = false;
    for (const field of FIELDS) {
      const original = row[field];
      const suspects = findSuspectMatches(original);
      if (suspects.length > 0) allSuspects.push({ slug: row.slug, field, suspects });

      const swapped = swapBrand(original);
      if (swapped !== original) {
        touched = true;
        const occ = occurrences(original);
        totals[field] += occ;
        fieldDiffs[field] = { occurrences: occ, before: original, after: swapped };
      }
    }
    if (touched) {
      diffs.push({
        id: row.id,
        slug: row.slug,
        fields: fieldDiffs,
        newValues: { og_title: swapBrand(row.og_title), og_description: swapBrand(row.og_description) },
      });
    }
  }

  if (allSuspects.length > 0) {
    console.error("ABORT: suspect brand-token matches found near a URL/slug-like context:");
    console.error(JSON.stringify(allSuspects, null, 2));
    process.exit(1);
  }

  const report = {
    mode: APPLY ? "apply" : "dry-run",
    scope: "og_title, og_description only (follow-up to fix-recova-brand.mjs)",
    totalPostsScanned: rows.length,
    postsWithChanges: diffs.length,
    occurrencesByField: totals,
    suspectMatchesFound: allSuspects.length,
    diffs: diffs.map((d) => ({ slug: d.slug, fields: d.fields })),
  };
  writeFileSync(LOG_PATH, JSON.stringify(report, null, 2));

  console.log(`\n=== Recova -> Foxhound og_title/og_description swap (${report.mode}) ===`);
  console.log(`Posts with changes: ${report.postsWithChanges}`);
  console.log(`Occurrences by field:`, totals);
  console.log(`Suspect matches (aborts if >0): ${allSuspects.length}`);
  console.log(`Log written to ${LOG_PATH}`);

  if (!APPLY) {
    console.log("\nDry run only. Re-run with --apply to write to D1.");
    return;
  }

  const statements = diffs.map((d) => {
    const sets = FIELDS.filter((f) => f in d.fields)
      .map((f) => `"${f}"=${sqlValue(d.newValues[f])}`)
      .join(", ");
    return `UPDATE "blog_posts" SET ${sets} WHERE "id"='${d.id}';`;
  });
  const sqlPath = join(SCRIPT_DIR, "out", "recova-brand-swap-og-apply.sql");
  writeFileSync(sqlPath, statements.join("\n") + "\n");
  if (statements.length > 0) d1ExecuteFile(sqlPath);

  // Verification is a plain read, deliberately NOT routed back through the
  // dry-run code path above (that is exactly what clobbered the previous
  // pass's log) -- it never calls writeFileSync(LOG_PATH, ...) again.
  const after = d1Query(`SELECT id, slug FROM blog_posts ORDER BY slug`);
  const slugsAfter = after.map((r) => r.slug).sort();
  const slugsMatch = JSON.stringify(slugsBefore) === JSON.stringify(slugsAfter);

  const remainingAllFields = d1Query(
    `SELECT COUNT(*) as cnt FROM blog_posts WHERE og_title GLOB '*Recova*' OR og_description GLOB '*Recova*' OR title GLOB '*Recova*' OR excerpt GLOB '*Recova*' OR body GLOB '*Recova*' OR author GLOB '*Recova*'`,
  );
  const remainingCount = remainingAllFields[0]?.cnt ?? -1;

  console.log(`\n=== Post-apply verification ===`);
  console.log(`Slug set unchanged: ${slugsMatch ? "YES" : "NO -- ABORT, INVESTIGATE"}`);
  console.log(`Remaining case-sensitive "Recova" across og_title/og_description/title/excerpt/body/author (expect 0): ${remainingCount}`);

  if (!slugsMatch || remainingCount !== 0) {
    console.error("VERIFICATION FAILED.");
    process.exit(1);
  }
  console.log("\nApply + verification OK.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
