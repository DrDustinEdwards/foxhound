import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { id, ts, bool, json } from "./columns";
import { accounts, accountRef, optionalAccountRef } from "./tenancy";

export const outcomes = sqliteTable(
  "outcomes",
  {
    id: id(),
    accountId: accountRef(),
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

// site-runtime ./cron's CRON_SQL and CRON_LOG_SQL, written by runJobs: one row per job (read by /health's cronCheck
// and the gates in app/lib/cron/run.ts) and each run kept (the admin Crons page, the alerts).
export { cronRunLog, cronRuns } from "@dustinedwards/site-runtime/drizzle";

// The outcome of each AI feature's last failed model call, kept by site-runtime's recordAiOutcome through d1FireStore
// (./routine) and read by /health's aiOutcomeCheck.
export const aiOutcomes = sqliteTable("ai_outcomes", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

// global
export const adminAuditLog = sqliteTable("admin_audit_log", {
  id: id(),
  actorEmail: text("actor_email").notNull(),
  action: text("action").notNull(),
  // soft ref to Better Auth user.id
  targetUserId: text("target_user_id"),
  targetEmail: text("target_email"),
  metadata: json("metadata"),
  createdAt: ts("created_at").notNull(),
});

/** Admin "View as merchant" (read-only). One row per session an admin opens on a merchant's app. The browser holds only a random token; this row holds its SHA-256, so the cookie names no account and a leaked row cannot be replayed. app/lib/admin/impersonation.server.ts is the one reader and writer; the app shell resolves the account from a row that is open, unexpired, and whose admin still passes Cloudflare Access. */
export const adminImpersonations = sqliteTable(
  "admin_impersonations",
  {
    id: id(),
    tokenHash: text("token_hash").notNull(),
    adminEmail: text("admin_email").notNull(),
    accountId: accountRef(),
    startedAt: ts("started_at").notNull(),
    expiresAt: ts("expires_at").notNull(),
    endedAt: ts("ended_at"),
    // 'stopped' (the admin pressed Stop) or 'expired' (seen past expires_at).
    endReason: text("end_reason"),
  },
  (t) => [
    uniqueIndex("admin_impersonations_token_hash_uq").on(t.tokenHash),
    index("admin_impersonations_account_idx").on(t.accountId),
  ],
);

/**
 * The write trace for the merchant MCP: which key wrote what.
 * A separate table from `admin_audit_log`, which is PLATFORM-scoped: its actor is an admin email, it has no `account_id` and no column for a key, and an agent write has no admin or email.
 * FIELD NAMES, NEVER VALUES: `fields` records WHICH columns a tool touched, not what it wrote, so the trace is not a second copy of merchant content with different retention and readers.
 * `api_key_id` IS A SOFT REF, deliberately (as `email_sends.cron_run_id`): a revoked or reaped key must not take its own history with it. A trace that can be deleted by the party it traces is not a trace.
 */
export const mcpWrites = sqliteTable(
  "mcp_writes",
  {
    id: id(),
    accountId: accountRef(),
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
 * Every MCP tool call, one row each: the caller, the arguments and the result.
 * WRITTEN AT THE DOOR, not in a tool (app/lib/mcp/call-log.server.ts), so a call the SDK refused at its schema check or one naming a tool that does not exist is logged as surely as a call that ran. `mcp_writes` stays the field-level trace that commits in the same batch as a write.
 * APPEND-ONLY IN THE SCHEMA: triggers abort any UPDATE or DELETE, so no code path can rewrite what a key did.
 * THE RESULT IS KEPT AS AN OUTCOME, never as the data a read returned, so the log is not a second copy of the merchant's customers. `arguments` has the Slack webhook URL replaced and `error` has email addresses masked.
 * `api_key_id` IS A SOFT REF, as on `mcp_writes`.
 */
export const mcpCalls = sqliteTable(
  "mcp_calls",
  {
    id: id(),
    accountId: accountRef(),
    /** api_keys.id. Soft ref; see the header. */
    apiKeyId: text("api_key_id").notNull(),
    /** oauth_clients.id (or a metadata-document URL) the key was issued to; null for a key made in Settings. */
    clientId: text("client_id"),
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
 * Changes an admin AI asked for that start or change money, waiting for a person. The Foxhound Admin API may pause directly, because pausing stops money moving. Resuming a merchant, releasing the brake, re-enabling a cron, exempting an account from billing and granting a plan all start or change money, so the API only STAGES them here. Nothing is applied until an admin confirms the row in /admin/staged, signed in, and the confirmation runs the same helper the matching /admin screen runs.
 * `status` is pending, confirmed, rejected or failed. A pending row older than seven days can no longer be confirmed (app/lib/admin/staged.server.ts). Every transition writes an admin_audit_log row naming the admin who made it.
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

/** Every call to the Foxhound Admin API, one row each. APPEND-ONLY IN THE SCHEMA, as `mcp_calls` is: triggers abort any UPDATE or DELETE. Only calls that passed both credentials are logged; a refused call has no acting admin to name. */
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
    accountId: optionalAccountRef(),
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

// ai_calls retention target: one row per (account, model, YYYY-MM); the retention sweeper aggregates aged raw rows (kept 90 days) here then deletes them in the same atomic batch. account_id is a soft aggregate key (no FK), storing "" for platform-level (null-account) calls so the unique index dedupes them too.
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
    accountId: accountRef(),
    stripeCustomerId: text("stripe_customer_id").notNull(),
    body: text("body").notNull(),
    createdBy: text("created_by"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [index("customer_notes_account_idx").on(t.accountId)],
);

// site-runtime ./not-found's daily 404 count per path.
export { page404Daily } from "@dustinedwards/site-runtime/drizzle";
