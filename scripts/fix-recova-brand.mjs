// Idempotent brand-token swap for the already-imported blog_posts content
// (Phase 6 Pass 2 STOP A follow-up). The Phase 2 transform (2026-07-12,
// transform-legacy-to-staging.mjs) carried the legacy "Recova" brand name
// through verbatim into 34 of 45 posts' body, 4 posts' title+excerpt, and
// all 45 posts' author column. This script replaces ONLY the brand token
// "Recova" / "Recova's" -> "Foxhound" / "Foxhound's" in author/title/
// excerpt/body. It is a token swap, not a content edit: no pricing figures,
// product names (Scale/Grow/AI Cost), or prose are touched, and the slug
// column is never part of the SELECT/UPDATE column set, so it structurally
// cannot be written.
//
// Usage:
//   node scripts/fix-recova-brand.mjs              # dry run, writes the log, no D1 write
//   node scripts/fix-recova-brand.mjs --apply       # applies the update, then re-verifies
//
// Idempotent: re-running after a successful apply computes zero diffs (the
// swap function is a no-op on already-swapped text), so a second --apply
// run is a safe no-op, not a double-write.

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";

const APPLY = process.argv.includes("--apply");
const RECONSTRUCT = process.argv.includes("--reconstruct-log");
const DB_NAME = "foxhound";
const FIELDS = ["author", "title", "excerpt", "body"];

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const LOG_PATH = join(SCRIPT_DIR, "recova-brand-swap-log.json");
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

// The swap itself: possessive form first (longer match consumes the
// apostrophe-s), then the remaining bare word-boundary occurrences. Both
// passes are case-sensitive (no /i flag) per the exact scope: "Recova" /
// "Recova's" only, not "recova" (which only appears as part of the
// recovamrr.com domain / recova-vs-* slugs, neither of which this touches).
function swapBrand(value) {
  if (value === null || value === undefined) return value;
  let out = value.replace(/Recova's/g, "Foxhound's");
  out = out.replace(/\bRecova\b/g, "Foxhound");
  return out;
}

// Self-review guard: a replacement is suspect if it sits inside something
// that looks like a URL or a slug fragment (a run of lowercase-hyphen
// text immediately adjacent, or an http(s) scheme within 40 chars before
// the match). Case-sensitivity already keeps this out of recovamrr.com and
// the recova-vs-* slugs (those are all-lowercase "recova", never matched
// by \bRecova\b), but this is a second, independent check on the actual
// matched positions rather than trusting that reasoning alone.
function findSuspectMatches(original) {
  const suspects = [];
  const re = /Recova(?:'s)?/g;
  let m;
  while ((m = re.exec(original)) !== null) {
    const before = original.slice(Math.max(0, m.index - 40), m.index);
    const after = original.slice(m.index, m.index + 40);
    if (/https?:\/\/\S*$/.test(before) || /^\S*\.(com|org|net|io)/.test(after) || /^-[a-z]/.test(after)) {
      suspects.push({ index: m.index, before, after });
    }
  }
  return suspects;
}

function fieldOccurrences(value) {
  if (!value) return 0;
  const m = value.match(/Recova(?:'s)?/g);
  return m ? m.length : 0;
}

// Reverse-reconstruction mode: used once, after an apply run's dry-run log
// was accidentally overwritten by a confirmatory re-run (process error,
// documented in the PR). This legacy content predates the Foxhound brand
// entirely (authored under the Recova name, no other mechanism could have
// introduced the token "Foxhound" into it), so every "Foxhound"/"Foxhound's"
// occurrence in the current, already-swapped D1 data is provably one this
// script's own --apply run produced. Reversing the same substitution
// therefore reconstructs the true pre-apply values exactly, not an
// approximation. This mode is READ-ONLY: it never writes to D1.
function reverseSwap(value) {
  if (value === null || value === undefined) return value;
  let out = value.replace(/Foxhound's/g, "Recova's");
  out = out.replace(/\bFoxhound\b/g, "Recova");
  return out;
}

async function reconstructLog() {
  const rows = d1Query(`SELECT id, slug, author, title, excerpt, body FROM blog_posts ORDER BY slug`);
  const diffs = [];
  const totals = { author: 0, title: 0, excerpt: 0, body: 0 };

  for (const row of rows) {
    const fieldDiffs = {};
    let touched = false;
    for (const field of FIELDS) {
      const current = row[field];
      const original = reverseSwap(current);
      if (original !== current) {
        touched = true;
        const occurrences = fieldOccurrences(swapBrand(original) === current ? original : original);
        // occurrences counted against the reconstructed "before" text, same
        // definition fieldOccurrences() uses elsewhere (counts Recova/Recova's).
        const trueOccurrences = (original.match(/Recova(?:'s)?/g) ?? []).length;
        totals[field] += trueOccurrences;
        if (field === "author" || field === "title" || field === "excerpt") {
          fieldDiffs[field] = { occurrences: trueOccurrences, before: original, after: current };
        } else {
          const snippets = [];
          const re = /Foxhound(?:'s)?/g;
          let m;
          while ((m = re.exec(current)) !== null) {
            const start = Math.max(0, m.index - 40);
            const end = Math.min(current.length, m.index + 40);
            snippets.push({ before: reverseSwap(current.slice(start, end)), after: current.slice(start, end) });
          }
          fieldDiffs[field] = { occurrences: trueOccurrences, snippets };
        }
      }
    }
    if (touched) diffs.push({ id: row.id, slug: row.slug, fields: fieldDiffs });
  }

  const report = {
    mode: "reconstructed-from-post-apply-state",
    note:
      "This log was regenerated by reversing the swap against the already-applied D1 data, after the original apply-time log was accidentally overwritten by a confirmatory dry-run. The reverse mapping is exact (this legacy content predates the Foxhound brand, so no other source could have introduced the token), not an approximation.",
    totalPostsScanned: rows.length,
    postsWithChanges: diffs.length,
    occurrencesByField: totals,
    suspectMatchesFound: 0,
    diffs: diffs.map((d) => ({ slug: d.slug, fields: d.fields })),
  };
  writeFileSync(LOG_PATH, JSON.stringify(report, null, 2));
  console.log(`Reconstructed log written to ${LOG_PATH}`);
  console.log(`Posts with changes: ${report.postsWithChanges}`);
  console.log(`Occurrences by field:`, totals);
}

async function main() {
  if (RECONSTRUCT) {
    await reconstructLog();
    return;
  }

  const rows = d1Query(`SELECT id, slug, author, title, excerpt, body FROM blog_posts ORDER BY slug`);
  console.log(`Loaded ${rows.length} blog_posts rows from D1.`);

  const diffs = [];
  const allSuspects = [];
  const slugsBefore = rows.map((r) => r.slug).sort();

  for (const row of rows) {
    const fieldDiffs = {};
    let touched = false;
    for (const field of FIELDS) {
      const original = row[field];
      const suspects = findSuspectMatches(original ?? "");
      if (suspects.length > 0) allSuspects.push({ slug: row.slug, field, suspects });

      const swapped = swapBrand(original);
      if (swapped !== original) {
        touched = true;
        const occurrences = fieldOccurrences(original);
        if (field === "author" || field === "title" || field === "excerpt") {
          fieldDiffs[field] = { occurrences, before: original, after: swapped };
        } else {
          // body: log context snippets around each match rather than the
          // full body text, to keep the log file readable.
          const snippets = [];
          const re = /Recova(?:'s)?/g;
          let m;
          while ((m = re.exec(original)) !== null) {
            const start = Math.max(0, m.index - 40);
            const end = Math.min(original.length, m.index + 40);
            snippets.push({
              before: original.slice(start, end),
              after: swapBrand(original.slice(start, end)),
            });
          }
          fieldDiffs[field] = { occurrences, snippets };
        }
      }
    }
    if (touched) {
      diffs.push({ id: row.id, slug: row.slug, fields: fieldDiffs, newValues: FIELDS.reduce((acc, f) => {
        acc[f] = swapBrand(row[f]);
        return acc;
      }, {}) });
    }
  }

  if (allSuspects.length > 0) {
    console.error("ABORT: suspect brand-token matches found near a URL/slug-like context:");
    console.error(JSON.stringify(allSuspects, null, 2));
    process.exit(1);
  }

  const totals = { posts: diffs.length };
  for (const field of FIELDS) {
    totals[field] = diffs.reduce((sum, d) => sum + (d.fields[field]?.occurrences ?? 0), 0);
  }

  const report = {
    mode: APPLY ? "apply" : "dry-run",
    totalPostsScanned: rows.length,
    postsWithChanges: diffs.length,
    occurrencesByField: { author: totals.author, title: totals.title, excerpt: totals.excerpt, body: totals.body },
    suspectMatchesFound: allSuspects.length,
    diffs: diffs.map((d) => ({ slug: d.slug, fields: d.fields })),
  };
  writeFileSync(LOG_PATH, JSON.stringify(report, null, 2));

  console.log(`\n=== Recova -> Foxhound brand swap (${report.mode}) ===`);
  console.log(`Posts scanned: ${report.totalPostsScanned}`);
  console.log(`Posts with changes: ${report.postsWithChanges}`);
  console.log(`Occurrences by field: author=${totals.author} title=${totals.title} excerpt=${totals.excerpt} body=${totals.body}`);
  console.log(`Suspect matches (aborts if >0): ${allSuspects.length}`);
  console.log(`Log written to ${LOG_PATH}`);

  if (!APPLY) {
    console.log("\nDry run only. Re-run with --apply to write to D1.");
    return;
  }

  // Apply: one UPDATE per changed row, only the fields that actually changed,
  // slug is never in the SET clause (structural guarantee against slug drift).
  function sqlValue(v) {
    if (v === null || v === undefined) return "NULL";
    return `'${String(v).replace(/'/g, "''")}'`;
  }
  const statements = diffs.map((d) => {
    const sets = FIELDS.filter((f) => f in d.fields)
      .map((f) => `"${f}"=${sqlValue(d.newValues[f])}`)
      .join(", ");
    return `UPDATE "blog_posts" SET ${sets} WHERE "id"='${d.id}';`;
  });
  const sqlPath = join(SCRIPT_DIR, "out", "recova-brand-swap-apply.sql");
  writeFileSync(sqlPath, statements.join("\n") + "\n");
  if (statements.length > 0) {
    d1ExecuteFile(sqlPath);
  }

  // Re-verify: zero case-sensitive "Recova" occurrences left in the four
  // fields (GLOB is case-sensitive in SQLite; LIKE is not), and the slug
  // set is byte-for-byte unchanged.
  const after = d1Query(`SELECT id, slug FROM blog_posts ORDER BY slug`);
  const slugsAfter = after.map((r) => r.slug).sort();
  const slugsMatch = JSON.stringify(slugsBefore) === JSON.stringify(slugsAfter);

  const remaining = d1Query(
    `SELECT COUNT(*) as cnt FROM blog_posts WHERE author GLOB '*Recova*' OR title GLOB '*Recova*' OR excerpt GLOB '*Recova*' OR body GLOB '*Recova*'`,
  );
  const remainingCount = remaining[0]?.cnt ?? -1;

  console.log(`\n=== Post-apply verification ===`);
  console.log(`Slug set unchanged: ${slugsMatch ? "YES" : "NO -- ABORT, INVESTIGATE"}`);
  console.log(`Remaining case-sensitive "Recova" occurrences (expect 0): ${remainingCount}`);

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
