import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { id, ts, bool, json } from "./columns";
import { accounts } from "./tenancy";

// ============================================================================
// Platform / ops
// ============================================================================

export const outcomes = sqliteTable(
  "outcomes",
  {
    id: id(),
    accountId: text("account_id").notNull().references(() => accounts.id),
    product: text("product").notNull(),
    eventType: text("event_type").notNull(),
    eventData: json("event_data"),
    outcome: text("outcome"),
    outcomeAt: ts("outcome_at"),
    createdAt: ts("created_at"),
    // idempotency key (SCHEMA.md spine #4); nullable for carried rows, required in app writes
    idempotencyKey: text("idempotency_key"),
    attributionKind: text("attribution_kind"),
    attributedRef: text("attributed_ref"),
  },
  (t) => [
    index("outcomes_account_idx").on(t.accountId),
    uniqueIndex("outcomes_idempotency_uq")
      .on(t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
  ],
);

export const webhookEvents = sqliteTable(
  "webhook_events",
  {
    id: id(),
    stripeEventId: text("stripe_event_id").notNull(),
    eventType: text("event_type").notNull(),
    receivedAt: ts("received_at").notNull(),
    accountId: text("account_id"),
    processed: bool("processed").notNull().default(false),
    errorMessage: text("error_message"),
    payload: json("payload").notNull(),
    processingStartedAt: ts("processing_started_at"),
  },
  (t) => [
    index("webhook_events_account_idx").on(t.accountId),
    // Retention sweep predicate (cron/retention.ts); without it every daily sweep reads the whole table.
    index("webhook_events_received_idx").on(t.receivedAt),
    uniqueIndex("webhook_events_stripe_event_uq").on(t.stripeEventId),
  ],
);

// global
export const cronConfig = sqliteTable("cron_config", {
  cronName: text("cron_name").primaryKey(),
  enabled: bool("enabled").notNull().default(true),
  minIntervalMinutes: integer("min_interval_minutes"),
  updatedAt: ts("updated_at").notNull(),
});

// global: single canonical run log (cron_runs merged in)
export const cronRunHistory = sqliteTable(
  "cron_run_history",
  {
    id: id(),
    cronName: text("cron_name").notNull(),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at").notNull(),
    status: text("status").notNull(),
    rowsProcessed: integer("rows_processed"),
    message: text("message"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    index("cron_run_history_cron_idx").on(t.cronName),
    // Retention sweep predicate (cron/retention.ts); without it every daily sweep reads the whole table.
    index("cron_run_history_created_idx").on(t.createdAt),
    // The admin overview's "last cron finished" read (admin/overview.server.ts).
    index("cron_run_history_finished_idx").on(t.finishedAt),
    // The admin Crons page (J72) reads each cron's newest run and newest
    // success (max finished_at grouped by cron and status, then those rows) and
    // the last day's failures. Without these it scans the whole history, which
    // the five-minute ticks fill at 576 rows a day.
    index("cron_run_history_cron_status_finished_idx").on(t.cronName, t.status, t.finishedAt),
    index("cron_run_history_status_finished_idx").on(t.status, t.finishedAt),
  ],
);

// global
export const adminAuditLog = sqliteTable("admin_audit_log", {
  id: id(),
  actorEmail: text("actor_email").notNull(),
  action: text("action").notNull(),
  // soft ref to Better Auth user.id (Phase 3)
  targetUserId: text("target_user_id"),
  targetEmail: text("target_email"),
  metadata: json("metadata"),
  createdAt: ts("created_at").notNull(),
});

/**
 * The write trace for the merchant MCP (372's item-4 ruling: "write-audit
 * logging of key id per write").
 *
 * WHY A NEW TABLE AND NOT `admin_audit_log`. That table is PLATFORM-scoped: its
 * actor is an admin email, it has no `account_id`, and it has no column for a
 * key. An agent write has no admin and no email; writing merchant self-service
 * changes into the platform admin trail would put two different subjects in one
 * table keyed on a field one of them cannot fill. Measured at HEAD before this
 * table was added, and stated in parity/AGENT-SURFACE.md.
 *
 * FIELD NAMES, NEVER VALUES. `fields` records WHICH columns a tool touched, not
 * what it wrote. A trace carrying the new brand voice would be a second copy of
 * merchant content living in a log with different retention and different
 * readers, which is a worse problem than the one the trace solves.
 *
 * `api_key_id` IS A SOFT REF, deliberately, mirroring `email_sends.cron_run_id`
 * and 314's FK-retention catch: the trace must survive anything that happens to
 * the key, and a revoked or reaped key must not take its own history with it.
 * A trace that can be deleted by the party it traces is not a trace.
 */
export const mcpWrites = sqliteTable(
  "mcp_writes",
  {
    id: id(),
    accountId: text("account_id").notNull().references(() => accounts.id),
    /** api_keys.id. Soft ref; see the header. */
    apiKeyId: text("api_key_id").notNull(),
    /** The MCP tool name that performed the write. */
    tool: text("tool").notNull(),
    /** The column names touched. Names only, never values. */
    fields: json<string[]>("fields"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [index("mcp_writes_account_idx").on(t.accountId)],
);

/**
 * Every MCP tool call, one row each (MCP ruling 2026-10-10, rule 12.4): the
 * caller, the arguments and the result.
 *
 * WRITTEN AT THE DOOR, not in a tool (app/lib/mcp/call-log.server.ts), so a call
 * the SDK refused at its schema check or a call naming a tool that does not
 * exist is logged as surely as a call that ran. `mcp_writes` stays the
 * field-level trace that commits in the same batch as a write; this is the
 * wider record of what every key asked for.
 *
 * APPEND-ONLY IN THE SCHEMA. Migration 0026 adds triggers that abort any UPDATE
 * or DELETE on this table, so no code path can rewrite what a key did.
 *
 * THE RESULT IS KEPT AS AN OUTCOME, never as the data a read returned, so the
 * log does not become a second copy of the merchant's customers. `arguments`
 * has the Slack webhook URL replaced and `error` has email addresses masked.
 *
 * `api_key_id` IS A SOFT REF, as on `mcp_writes`: the record must survive the
 * key being revoked or reaped.
 */
export const mcpCalls = sqliteTable(
  "mcp_calls",
  {
    id: id(),
    accountId: text("account_id").notNull().references(() => accounts.id),
    /** api_keys.id. Soft ref; see the header. */
    apiKeyId: text("api_key_id").notNull(),
    /** The tool name the call asked for, whether or not it exists. */
    tool: text("tool").notNull(),
    /** The arguments as sent, with credentials replaced. */
    arguments: json<Record<string, unknown>>("arguments"),
    /** ok | tool_error | protocol_error */
    outcome: text("outcome").notNull(),
    /** The error text the agent was given, emails masked; null on ok. */
    error: text("error"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    index("mcp_calls_account_idx").on(t.accountId, t.createdAt),
    // /admin/mcps: the newest calls, and the last day's calls and failures.
    index("mcp_calls_created_idx").on(t.createdAt, t.outcome),
  ],
);

/**
 * Changes an admin AI asked for that start or change money, waiting for a person
 * (MCP ruling 2026-10-10, DECIDE answer 4; job_21de68b30fc2).
 *
 * The Foxhound Admin API may pause directly, because pausing stops money
 * moving. Resuming a merchant, releasing the brake, re-enabling a cron,
 * exempting an account from billing and granting a plan all start or change
 * money, so the API only STAGES them here. Nothing is applied until an admin
 * confirms the row in /admin/staged, signed in, and the confirmation runs the
 * same helper the matching /admin screen runs.
 *
 * `status` is pending, confirmed, rejected or failed. A pending row older than
 * seven days can no longer be confirmed (app/lib/admin/staged.server.ts). Every
 * transition writes an admin_audit_log row naming the admin who made it.
 */
export const stagedChanges = sqliteTable(
  "staged_changes",
  {
    id: id(),
    /** resume_account | release_brake | cron_enable | billing_exempt */
    kind: text("kind").notNull(),
    targetAccountId: text("target_account_id").references(() => accounts.id),
    targetCronName: text("target_cron_name"),
    /** Kind-specific values, for example { exempt: true }. */
    params: json<Record<string, unknown>>("params"),
    /** Why the requester wants it, as they said it. */
    note: text("note"),
    status: text("status").notNull().default("pending"),
    requestedBy: text("requested_by").notNull(),
    /** Where the request came from: "admin-api" today. */
    requestedVia: text("requested_via").notNull(),
    requestedAt: ts("requested_at").notNull(),
    decidedBy: text("decided_by"),
    decidedAt: ts("decided_at"),
    /** What applying it did, or why it failed. */
    result: json<Record<string, unknown>>("result"),
  },
  (t) => [index("staged_changes_status_idx").on(t.status, t.requestedAt)],
);

/**
 * Every call to the Foxhound Admin API, one row each (MCP ruling rule 12.4 for
 * the admin server, whose own Worker holds no database).
 *
 * APPEND-ONLY IN THE SCHEMA, as `mcp_calls` is: migration 0027 adds triggers
 * that abort any UPDATE or DELETE. Only calls that passed both credentials are
 * logged; a refused call has no acting admin to name.
 */
export const adminApiCalls = sqliteTable(
  "admin_api_calls",
  {
    id: id(),
    actorEmail: text("actor_email").notNull(),
    /** api_keys.id of the admin key. Soft ref, as on mcp_writes. */
    apiKeyId: text("api_key_id").notNull(),
    method: text("method").notNull(),
    /** The path under /api/admin/v1, without the query. */
    path: text("path").notNull(),
    /** The query parameters and JSON body, as sent. */
    input: json<Record<string, unknown>>("input"),
    status: integer("status").notNull(),
    error: text("error"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [index("admin_api_calls_created_idx").on(t.createdAt)],
);

export const aiCalls = sqliteTable(
  "ai_calls",
  {
    id: id(),
    accountId: text("account_id").references(() => accounts.id),
    source: text("source").notNull(),
    model: text("model").notNull(),
    promptTokens: integer("prompt_tokens").notNull(),
    completionTokens: integer("completion_tokens").notNull(),
    costCents: integer("cost_cents").notNull(),
    // internal cost is USD; currency column present to satisfy the money+currency rule
    currency: text("currency").notNull().default("usd"),
    relatedId: text("related_id"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [index("ai_calls_account_idx").on(t.accountId)],
);

// ai_calls retention target (ARCHITECTURE.md: raw 90 days, monthly cost aggregates
// after). One row per (account, model, YYYY-MM); the retention sweeper aggregates
// aged raw rows here then deletes them in the same atomic batch. account_id is a
// soft aggregate key (no FK), storing "" for platform-level (null-account) calls
// so the unique index dedupes them too.
export const aiCallsMonthly = sqliteTable(
  "ai_calls_monthly",
  {
    id: id(),
    accountId: text("account_id").notNull(),
    model: text("model").notNull(),
    month: text("month").notNull(), // YYYY-MM (UTC)
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    costCents: integer("cost_cents").notNull().default(0),
    currency: text("currency").notNull().default("usd"),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [uniqueIndex("ai_calls_monthly_uq").on(t.accountId, t.model, t.month)],
);

// global single-row rollup; total_recovered_usd is a USD-denominated aggregate by definition
export const platformStats = sqliteTable("platform_stats", {
  id: integer("id").primaryKey(),
  totalRecoveredUsd: integer("total_recovered_usd"),
  totalMerchants: integer("total_merchants"),
  totalFailedDetected: integer("total_failed_detected"),
  totalEmailsSent: integer("total_emails_sent"),
  avgRecoveryRatePct: real("avg_recovery_rate_pct"),
  avgHoursToFirstRecovery: real("avg_hours_to_first_recovery"),
  lastComputedAt: ts("last_computed_at"),
});

export const customerNotes = sqliteTable(
  "customer_notes",
  {
    id: id(),
    accountId: text("account_id").notNull().references(() => accounts.id),
    stripeCustomerId: text("stripe_customer_id").notNull(),
    body: text("body").notNull(),
    createdBy: text("created_by"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [index("customer_notes_account_idx").on(t.accountId)],
);

// NEW: daily aggregate per path (raw page_404s rows are not migrated; see legacy-map.md)
export const page404Daily = sqliteTable(
  "page_404_daily",
  {
    id: id(),
    day: ts("day").notNull(),
    path: text("path").notNull(),
    hitCount: integer("hit_count").notNull().default(0),
  },
  (t) => [uniqueIndex("page_404_daily_day_path_uq").on(t.day, t.path)],
);
