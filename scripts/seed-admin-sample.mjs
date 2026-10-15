#!/usr/bin/env node
// Sample data for looking at /admin locally (screenshots, review): a few
// merchants (one paused), cron runs including one FAILED run on a registered
// cron, webhook events, a blog post, audit entries with real targets, and what
// the Overview's figures and Needs attention read: a new Stripe connection, a
// dispute a week old with no response, a fee invoice whose charge failed,
// recoveries this month in two currencies and an MRR snapshot. Times are relative to
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
  row("accounts", { id: "sample_acct_lumen", name: "Lumen Studio", created_at: ago(3 * DAY), billing_exempt: 0, processing_paused: 1 }),
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

  // What the Overview reads besides the crons and the audit log.
  row("stripe_connections", {
    id: "sample_conn_lumen",
    account_id: "sample_acct_lumen",
    stripe_user_id: "acct_sample_lumen",
    connected_at: ago(2 * DAY),
    created_at: ago(2 * DAY),
    is_primary: 1,
  }),
  row("disputes", {
    id: "sample_dispute_northwind",
    account_id: "sample_acct_northwind",
    stripe_dispute_id: "dp_sample_northwind",
    stripe_charge_id: "ch_sample_northwind",
    amount_cents: 12900,
    currency: "usd",
    reason: "product_not_received",
    status: "needs_response",
    state: "draft",
    evidence_deadline: ago(-4 * DAY),
    created_at: ago(9 * DAY),
  }),
  row("billing_invoices", {
    id: "sample_invoice_northwind",
    account_id: "sample_acct_northwind",
    currency: "usd",
    period_start: ago(45 * DAY),
    period_end: ago(14 * DAY),
    status: "payment_failed",
    total_cents: 2580,
    idempotency_key: "sample_invoice_northwind",
    created_at: ago(14 * DAY),
    charge_attempt_count: 2,
    last_charge_attempt_at: ago(1 * DAY),
  }),
  ...[
    ["sample_fp_1", "sample_acct_northwind", 4900, "usd", 2],
    ["sample_fp_2", "sample_acct_northwind", 12900, "usd", 6],
    ["sample_fp_3", "sample_acct_harbor", 3500, "eur", 4],
  ].flatMap(([id, account, cents, currency, days]) => [
    row("failed_payments", {
      id,
      stripe_event_id: `evt_${id}`,
      stripe_invoice_id: `in_${id}`,
      stripe_customer_id: `cus_${id}`,
      customer_email: "customer@example.com",
      amount_cents: cents,
      currency,
      decline_category: "soft",
      status: "recovered",
      detected_at: ago((days + 3) * DAY),
      account_id: account,
    }),
    row("recovered_payments", {
      id: `rp_${id}`,
      failed_payment_id: id,
      recovered_at: ago(days * HOUR),
      amount_cents: cents,
      currency,
      recovery_method: "retry",
      account_id: account,
    }),
  ]),
  row("mrr_snapshots", {
    id: "sample_mrr_northwind",
    account_id: "sample_acct_northwind",
    snapshot_date: ago(1 * DAY),
    total_mrr_cents: 1840000,
    new_mrr_cents: 0,
    expansion_mrr_cents: 0,
    contraction_mrr_cents: 0,
    churn_mrr_cents: 0,
    reactivation_mrr_cents: 0,
    active_customers_count: 212,
    new_customers_count: 0,
    churned_customers_count: 0,
    per_plan_breakdown: "{}",
    per_cohort_breakdown: "{}",
    per_channel_breakdown: "{}",
    currency: "usd",
    created_at: ago(1 * DAY),
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
