// Checksummed, idempotent transform of the KEEP content/reference tables from
// the legacy database into the Foxhound staging D1. Scope (per Phase 2 C5): the
// content/reference tables that hold real (non-demo) data -- blog_posts,
// benchmark_data, and social_*. All tenant tables hold demo data only and are
// re-seeded later, not migrated (legacy-map.md). blog_post_links and
// blog_post_versions are KEEP-eligible but out of this transform's scope.
//
// Reads legacy read-only via the PostgREST REST API. Requires two env vars set
// by the operator (never committed, never logged):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Writes to staging D1 via `wrangler d1 execute --remote` using upserts
// (INSERT ... ON CONFLICT(id) DO UPDATE), so re-running changes nothing.
//
// Usage:
//   node scripts/transform-legacy-to-staging.mjs            # fetch, import, verify
//   node scripts/transform-legacy-to-staging.mjs --dry-run  # fetch + write SQL only

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DRY_RUN = process.argv.includes("--dry-run");
const DB_NAME = "foxhound";
const ENV = "staging";

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment.");
  process.exit(1);
}

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "out");
mkdirSync(OUT_DIR, { recursive: true });

// Import order is FK-safe (parents before children).
const SPECS = [
  { table: "benchmark_data", ts: ["computed_at"], bool: [], json: [], sum: ["id", "cohort_dimension", "cohort_value", "metric_name", "computed_at"] },
  { table: "blog_posts", ts: ["published_at", "created_at", "updated_at"], bool: ["published", "show_updated_at", "show_published_at", "featured"], json: ["tags"], sum: ["id", "slug", "updated_at"] },
  { table: "social_config", ts: ["created_at", "updated_at"], bool: ["enabled", "post_enabled", "reply_enabled", "reddit_ready"], json: [], sum: ["id", "platform", "updated_at"] },
  { table: "social_keywords", ts: ["created_at", "last_used_at"], bool: ["enabled", "is_competitor"], json: [], sum: ["id", "query", "created_at"] },
  { table: "social_leads", ts: ["scout_run_at", "replied_at", "created_at", "reply_approved_at"], bool: ["is_competitor_mention", "is_google_ranking"], json: ["keywords_matched"], sum: ["id", "post_url", "created_at"], fk: { col: "keyword_id", parent: "social_keywords" } },
  { table: "social_posts", ts: ["posted_at", "created_at"], bool: [], json: [], sum: ["id", "platform", "created_at"], fk: { col: "lead_id", parent: "social_leads" } },
  { table: "social_topic_log", ts: ["used_at"], bool: [], json: [], sum: ["id", "topic_key", "used_at"] },
  { table: "social_blocklist", ts: ["created_at"], bool: [], json: [], sum: ["id", "value", "created_at"] },
];

async function fetchAll(table) {
  const rows = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const res = await fetch(
      `${SB_URL}/rest/v1/${table}?select=*&order=id&limit=${pageSize}&offset=${offset}`,
      { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } },
    );
    if (!res.ok) throw new Error(`fetch ${table} failed: ${res.status} ${await res.text()}`);
    const page = await res.json();
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}

function transformRow(row, spec) {
  const out = {};
  const tsSet = new Set(spec.ts);
  const boolSet = new Set(spec.bool);
  const jsonSet = new Set(spec.json);
  for (const [k, v] of Object.entries(row)) {
    if (v === null || v === undefined) { out[k] = null; }
    else if (tsSet.has(k)) { out[k] = Date.parse(v); }
    else if (boolSet.has(k)) { out[k] = v ? 1 : 0; }
    else if (jsonSet.has(k)) { out[k] = JSON.stringify(v); }
    else { out[k] = v; }
  }
  return out;
}

function sqlValue(v) {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "1" : "0";
  return `'${String(v).replace(/'/g, "''")}'`;
}

function buildUpserts(table, rows) {
  if (rows.length === 0) return "";
  const cols = Object.keys(rows[0]);
  const setClause = cols.filter((c) => c !== "id").map((c) => `"${c}"=excluded."${c}"`).join(", ");
  const lines = rows.map((r) => {
    const vals = cols.map((c) => sqlValue(r[c])).join(", ");
    return `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${vals}) ON CONFLICT("id") DO UPDATE SET ${setClause};`;
  });
  return lines.join("\n") + "\n";
}

function checksum(rows, subset) {
  const h = createHash("sha256");
  const sorted = [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  for (const r of sorted) {
    h.update(subset.map((c) => `${c}=${r[c] === null || r[c] === undefined ? "" : r[c]}`).join("|"));
    h.update("\n");
  }
  return h.digest("hex").slice(0, 16);
}

// Invoke wrangler's JS entry through node directly (no shell), so args with
// spaces are preserved exactly (avoids the shell:true word-split on --command).
const WRANGLER_BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "wrangler", "bin", "wrangler.js");
function wrangler(args) {
  return execFileSync(process.execPath, [WRANGLER_BIN, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function d1Query(sql) {
  // --command returns inline results; --file uploads and returns only stats.
  const out = wrangler(["d1", "execute", DB_NAME, "--env", ENV, "--remote", "--json", "--command", sql]);
  const start = out.indexOf("[");
  const parsed = JSON.parse(out.slice(start));
  return parsed[0]?.results ?? [];
}

async function main() {
  const report = [];
  const importedIds = {}; // parent table -> Set of ids, for FK guarding

  for (const spec of SPECS) {
    const raw = await fetchAll(spec.table);
    let rows = raw.map((r) => transformRow(r, spec));

    // referential guard: null out FK refs whose parent was not imported
    let nulledFks = 0;
    if (spec.fk) {
      const parentIds = importedIds[spec.fk.parent] ?? new Set();
      for (const r of rows) {
        if (r[spec.fk.col] !== null && !parentIds.has(r[spec.fk.col])) {
          r[spec.fk.col] = null;
          nulledFks++;
        }
      }
    }
    importedIds[spec.table] = new Set(rows.map((r) => r.id));

    const sql = buildUpserts(spec.table, rows);
    const sqlPath = join(OUT_DIR, `${spec.table}.sql`);
    writeFileSync(sqlPath, sql);

    const sourceSum = checksum(rows, spec.sum);
    let d1Count = null;
    let d1Sum = null;

    if (!DRY_RUN) {
      if (rows.length > 0) {
        wrangler(["d1", "execute", DB_NAME, "--env", ENV, "--remote", "--file", sqlPath]);
      }
      const d1Rows = d1Query(`SELECT ${spec.sum.map((c) => `"${c}"`).join(", ")} FROM "${spec.table}" ORDER BY id`);
      d1Count = d1Rows.length;
      d1Sum = checksum(d1Rows, spec.sum);
    }

    report.push({
      table: spec.table,
      source_rows: rows.length,
      d1_rows: d1Count,
      source_checksum: sourceSum,
      d1_checksum: d1Sum,
      nulled_fks: nulledFks,
      match: DRY_RUN ? "(dry-run)" : rows.length === d1Count && sourceSum === d1Sum ? "OK" : "MISMATCH",
    });
  }

  writeFileSync(join(OUT_DIR, "transform-report.json"), JSON.stringify(report, null, 2));
  console.log("\n=== Transform report (source vs staging D1) ===");
  console.table(report);
  const bad = report.filter((r) => r.match === "MISMATCH");
  if (bad.length) { console.error(`\n${bad.length} table(s) MISMATCH`); process.exit(1); }
  console.log(DRY_RUN ? "\nDry run complete (no D1 writes)." : "\nAll tables parity + checksum OK.");
}

main().catch((e) => { console.error(e); process.exit(1); });
