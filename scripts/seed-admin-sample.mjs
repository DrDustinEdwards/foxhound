#!/usr/bin/env node
// Sample data for looking at /admin locally (screenshots, review): a few
// merchants, cron runs including one FAILED run on a registered cron, webhook
// events, a blog post and audit entries with real targets. Times are relative to
// now, so "5 hours ago" stays true whenever this runs.
//
// LOCAL ONLY. It runs `wrangler d1 execute foxhound --local` and nothing else:
// there is no flag that points it at the remote database, which is production
// (see scripts/db-migrate.mjs). Run `npm run db:migrate` first. Re-runnable:
// every row has a fixed id and is replaced.
//
//   node scripts/seed-admin-sample.mjs

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const now = Date.now();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const ago = (ms) => now - ms;
const q = (v) => (v === null ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replaceAll("'", "''")}'`);
const row = (table, values) =>
  `INSERT OR REPLACE INTO ${table} (${Object.keys(values).join(", ")}) VALUES (${Object.values(values).map(q).join(", ")});`;

const sql = [
  // Merchants.
  row("accounts", { id: "sample_acct_northwind", name: "Northwind Coffee", created_at: ago(20 * DAY), billing_exempt: 0 }),
  row("accounts", { id: "sample_acct_lumen", name: "Lumen Studio", created_at: ago(3 * DAY), billing_exempt: 0 }),
  row("accounts", { id: "sample_acct_harbor", name: "Harbor Yoga", created_at: ago(90 * DAY), billing_exempt: 1 }),

  // Cron runs on registered crons. weekly-digest failed 5 hours ago: the run
  // the Overview counts and links to, shown on its cron on /admin/crons.
  row("cron_run_history", {
    id: "sample_run_digest_failed",
    cron_name: "weekly-digest",
    started_at: ago(5 * HOUR + 4000),
    finished_at: ago(5 * HOUR),
    status: "failed",
    rows_processed: 0,
    message: "Email binding unavailable",
    created_at: ago(5 * HOUR),
  }),
  row("cron_run_history", {
    id: "sample_run_tick_1",
    cron_name: "recovery-tick",
    started_at: ago(20 * 60 * 1000 + 3000),
    finished_at: ago(20 * 60 * 1000),
    status: "success",
    rows_processed: 4,
    message: null,
    created_at: ago(20 * 60 * 1000),
  }),
  row("cron_run_history", {
    id: "sample_run_backup",
    cron_name: "d1-backup",
    started_at: ago(15 * HOUR + 9000),
    finished_at: ago(15 * HOUR),
    status: "success",
    rows_processed: 31,
    message: null,
    created_at: ago(15 * HOUR),
  }),

  // Webhook events.
  row("webhook_events", {
    id: "sample_evt_1",
    stripe_event_id: "evt_sample_payment_failed",
    event_type: "invoice.payment_failed",
    received_at: ago(2 * HOUR),
    account_id: "sample_acct_northwind",
    processed: 1,
    payload: "{}",
  }),
  row("webhook_events", {
    id: "sample_evt_2",
    stripe_event_id: "evt_sample_sub_updated",
    event_type: "customer.subscription.updated",
    received_at: ago(7 * HOUR),
    account_id: "sample_acct_lumen",
    processed: 1,
    payload: "{}",
  }),

  // Audit entries, each with the metadata the real action writes.
  row("admin_audit_log", {
    id: "sample_audit_cron",
    actor_email: "admin@example.com",
    action: "cron.disable",
    metadata: JSON.stringify({ cronName: "winback-send" }),
    created_at: ago(26 * HOUR),
  }),
  row("admin_audit_log", {
    id: "sample_audit_cron_on",
    actor_email: "admin@example.com",
    action: "cron.enable",
    metadata: JSON.stringify({ cronName: "winback-send" }),
    created_at: ago(25 * HOUR),
  }),
  row("admin_audit_log", {
    id: "sample_audit_pause",
    actor_email: "admin@example.com",
    action: "merchant.processing.pause",
    metadata: JSON.stringify({ accountId: "sample_acct_northwind" }),
    created_at: ago(30 * HOUR),
  }),
  row("admin_audit_log", {
    id: "sample_audit_brake",
    actor_email: "admin@example.com",
    action: "brake.engage",
    metadata: JSON.stringify({ intendedCount: 3 }),
    created_at: ago(50 * HOUR),
  }),
  row("admin_audit_log", {
    id: "sample_audit_brake_off",
    actor_email: "admin@example.com",
    action: "brake.release",
    metadata: JSON.stringify({ intendedCount: 3 }),
    created_at: ago(49 * HOUR),
  }),
  row("admin_audit_log", {
    id: "sample_audit_exempt",
    actor_email: "admin@example.com",
    action: "merchant.billing_exempt.enable",
    metadata: JSON.stringify({ accountId: "sample_acct_harbor" }),
    created_at: ago(4 * DAY),
  }),
].join("\n");

const dir = mkdtempSync(join(tmpdir(), "foxhound-seed-"));
const file = join(dir, "seed.sql");
writeFileSync(file, sql);
try {
  const result = spawnSync("npx", ["wrangler", "d1", "execute", "foxhound", "--local", `--file=${file}`], {
    stdio: "inherit",
  });
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
