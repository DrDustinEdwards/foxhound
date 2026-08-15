// Backfill blog_post_links (~225 rows) and blog_post_versions (~14 rows)
// into foxhound-staging D1, from static read-only CSV exports (Phase 6
// Pass 2 STOP A). blog_posts itself is NOT touched here: it was already
// imported and checksummed by the Phase 2 transform
// (transform-legacy-to-staging.mjs, 2026-07-12) and is treated as
// authoritative.
//
// Source shape: each export file is a CSV wrapper around a single
// json_agg cell -- header "json_agg", one data row whose one field is the
// full JSON array as text (CSV-quoted, internal quotes doubled per RFC4180).
// This is NOT a normal row-per-record CSV; this script parses the CSV
// envelope, then JSON.parses the single cell to get the real records.
//
// File-based load only: every INSERT is written to a .sql file under
// scripts/out/ (gitignored, consistent with the Phase 2 transform's own
// convention) and applied via `wrangler d1 execute --file`, never inlined
// or hand-constructed on the command line.
//
// Usage:
//   node scripts/backfill-blog-links-versions.mjs          # dry run
//   node scripts/backfill-blog-links-versions.mjs --apply  # writes to D1

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APPLY = process.argv.includes("--apply");
const DB_NAME = "foxhound-production";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(SCRIPT_DIR, "out");
const LOG_PATH = join(SCRIPT_DIR, "backfill-blog-links-versions-log.json");
const WRANGLER_BIN = join(SCRIPT_DIR, "..", "node_modules", "wrangler", "bin", "wrangler.js");

const LINKS_CSV = join(OUT_DIR, "blog_post_links.csv");
const VERSIONS_CSV = join(OUT_DIR, "blog_post_versions.csv");

function wrangler(args) {
  return execFileSync(process.execPath, [WRANGLER_BIN, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1024 * 1024 * 128,
  });
}

function d1Query(sql) {
  const out = wrangler(["d1", "execute", DB_NAME, "--remote", "--json", "--command", sql]);
  const start = out.indexOf("[");
  return JSON.parse(out.slice(start))[0]?.results ?? [];
}

function d1ExecuteFile(path) {
  wrangler(["d1", "execute", DB_NAME, "--remote", "--file", path]);
}

// RFC4180-ish CSV parser: quoted fields, doubled-quote escaping, embedded
// commas/newlines inside quotes. Needed even for this one-cell-per-file
// shape because the cell itself is many KB of JSON containing literal
// commas, quotes, and newlines (markdown post bodies).
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (c === "\r") {
      i++;
      continue;
    }
    if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    field += c;
    i++;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function loadJsonAggCsv(path) {
  const text = readFileSync(path, "utf8");
  const rows = parseCsv(text).filter((r) => !(r.length === 1 && r[0] === ""));
  if (rows.length < 2) {
    throw new Error(`${path}: expected a header row + 1 data row, got ${rows.length} row(s)`);
  }
  if (rows[0].length !== 1 || rows[0][0] !== "json_agg") {
    throw new Error(`${path}: expected a single "json_agg" header column, got ${JSON.stringify(rows[0])}`);
  }
  return JSON.parse(rows[1][0]);
}

function sqlValue(v) {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}

async function main() {
  if (!existsSync(LINKS_CSV) || !existsSync(VERSIONS_CSV)) {
    console.error(`Expected source files at:\n  ${LINKS_CSV}\n  ${VERSIONS_CSV}`);
    process.exit(1);
  }

  const links = loadJsonAggCsv(LINKS_CSV);
  const versions = loadJsonAggCsv(VERSIONS_CSV);

  // Pre-load fingerprint (source precision). Halt BEFORE touching D1 if
  // the parsed data doesn't match the pre-verified source aggregates.
  const sumLen = (field) => versions.reduce((s, r) => s + String(r[field]).length, 0);
  const preChecks = [
    { name: "links.count", expected: 225, actual: links.length },
    { name: "links.sum(position)", expected: 559, actual: links.reduce((s, r) => s + Number(r.position), 0) },
    { name: "versions.count", expected: 14, actual: versions.length },
    { name: "versions.sum(len title)", expected: 864, actual: sumLen("title") },
    { name: "versions.sum(len body)", expected: 77846, actual: sumLen("body") },
    { name: "versions.sum(len excerpt)", expected: 2507, actual: sumLen("excerpt") },
  ];
  console.log("=== Pre-load fingerprint (source) ===");
  console.table(preChecks);
  const preMismatches = preChecks.filter((c) => c.expected !== c.actual);
  if (preMismatches.length > 0) {
    console.error(`ABORT: ${preMismatches.length} pre-load fingerprint mismatch(es). Not touching D1.`);
    process.exit(1);
  }

  // FK guard: every link/version endpoint must exist among the 45
  // already-imported blog_posts.
  const postRows = d1Query(`SELECT id FROM blog_posts`);
  const postIds = new Set(postRows.map((r) => r.id));

  const droppedLinks = [];
  const validLinks = links.filter((l) => {
    const ok = postIds.has(l.source_id) && postIds.has(l.target_id);
    if (!ok) droppedLinks.push({ id: l.id, source_id: l.source_id, target_id: l.target_id });
    return ok;
  });

  const droppedVersions = [];
  const validVersions = versions.filter((v) => {
    const ok = postIds.has(v.post_id);
    if (!ok) droppedVersions.push({ id: v.id, post_id: v.post_id });
    return ok;
  });

  // Keep-last-10-per-post trim (SCHEMA.md), grouped by post_id, newest
  // saved_at first.
  const byPost = new Map();
  for (const v of validVersions) {
    if (!byPost.has(v.post_id)) byPost.set(v.post_id, []);
    byPost.get(v.post_id).push(v);
  }
  const trimmedReport = [];
  const keptVersions = [];
  for (const [postId, list] of byPost) {
    list.sort((a, b) => Date.parse(b.saved_at) - Date.parse(a.saved_at));
    keptVersions.push(...list.slice(0, 10));
    if (list.length > 10) {
      trimmedReport.push({ postId, total: list.length, trimmed: list.length - 10 });
    }
  }

  // Transform + write file-based INSERT SQL. created_at/saved_at convert
  // ISO timestamptz -> epoch ms via Date.parse; every other column maps
  // 1:1. Version bodies are inserted VERBATIM (including legacy "Recova"
  // strings) -- these are historical edit-history snapshots, not live
  // content, and are explicitly out of scope for the brand-token swap
  // (logged separately as a Phase 7 item).
  const linkStatements = validLinks.map((l) => {
    const cols = ["id", "source_id", "target_id", "position", "created_at"];
    const vals = [l.id, l.source_id, l.target_id, l.position, Date.parse(l.created_at)];
    return `INSERT INTO "blog_post_links" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${vals.map(sqlValue).join(", ")}) ON CONFLICT("id") DO NOTHING;`;
  });
  const versionStatements = keptVersions.map((v) => {
    const cols = ["id", "post_id", "title", "body", "excerpt", "saved_at", "saved_by"];
    const vals = [v.id, v.post_id, v.title, v.body, v.excerpt, Date.parse(v.saved_at), v.saved_by ?? null];
    return `INSERT INTO "blog_post_versions" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${vals.map(sqlValue).join(", ")}) ON CONFLICT("id") DO NOTHING;`;
  });

  const linksSqlPath = join(OUT_DIR, "blog_post_links-insert.sql");
  const versionsSqlPath = join(OUT_DIR, "blog_post_versions-insert.sql");
  writeFileSync(linksSqlPath, linkStatements.join("\n") + "\n");
  writeFileSync(versionsSqlPath, versionStatements.join("\n") + "\n");

  const report = {
    mode: APPLY ? "apply" : "dry-run",
    preLoadFingerprint: preChecks,
    droppedLinks,
    droppedVersions,
    versionsTrimmed: trimmedReport,
    linksToInsert: linkStatements.length,
    versionsToInsert: versionStatements.length,
  };
  writeFileSync(LOG_PATH, JSON.stringify(report, null, 2));

  console.log(`\nLinks to insert: ${linkStatements.length} (dropped: ${droppedLinks.length})`);
  console.log(`Versions to insert: ${versionStatements.length} (dropped: ${droppedVersions.length}, trimmed groups: ${trimmedReport.length})`);
  console.log(`Log written to ${LOG_PATH}`);

  if (!APPLY) {
    console.log("\nDry run only. SQL staged in scripts/out/ but not executed. Re-run with --apply.");
    return;
  }

  if (linkStatements.length > 0) d1ExecuteFile(linksSqlPath);
  if (versionStatements.length > 0) d1ExecuteFile(versionsSqlPath);

  // Post-load verification: counts + content-length aggregates ONLY.
  // Timestamp sums are deliberately not asserted here: Date.parse
  // truncates Postgres's microsecond timestamptz precision to
  // milliseconds, so a post-load sum will legitimately land a few ms
  // below a source value computed at full precision -- asserting exact
  // equality there would be a false-mismatch trap, not a real integrity
  // check.
  const linksAfter = d1Query(`SELECT COUNT(*) as cnt, SUM(position) as sum_position FROM blog_post_links`);
  const versionsAfter = d1Query(
    `SELECT COUNT(*) as cnt, SUM(LENGTH(title)) as sum_title, SUM(LENGTH(body)) as sum_body, SUM(LENGTH(excerpt)) as sum_excerpt FROM blog_post_versions`,
  );

  const postChecks = [
    { name: "links.count", expected: 225, actual: linksAfter[0]?.cnt },
    { name: "links.sum(position)", expected: 559, actual: linksAfter[0]?.sum_position },
    { name: "versions.count", expected: 14, actual: versionsAfter[0]?.cnt },
    { name: "versions.sum(len title)", expected: 864, actual: versionsAfter[0]?.sum_title },
    { name: "versions.sum(len body)", expected: 77846, actual: versionsAfter[0]?.sum_body },
    { name: "versions.sum(len excerpt)", expected: 2507, actual: versionsAfter[0]?.sum_excerpt },
  ];
  console.log("\n=== Post-load fingerprint (D1) ===");
  console.table(postChecks);

  report.postLoadFingerprint = postChecks;
  writeFileSync(LOG_PATH, JSON.stringify(report, null, 2));

  const postMismatches = postChecks.filter((c) => c.expected !== c.actual);
  if (postMismatches.length > 0) {
    console.error(`POST-LOAD MISMATCH: ${postMismatches.length} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nApply + verification OK.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
