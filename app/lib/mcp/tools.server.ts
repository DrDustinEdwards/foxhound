import { getAuditRun, listAuditRuns } from "~/lib/audit/persist.server";
import { toStoredAuditRun } from "~/lib/audit/render";
import { getBillingPreview } from "~/lib/billing/preview.server";
import { getBillingLedger, listBillingInvoices } from "~/lib/billing/queries.server";
import { listDisputes, type DisputeRow } from "~/lib/disputes/queries.server";
import { getAlertsView, getCustomerHealthDetail, getIntelligenceOverview } from "~/lib/intelligence/views.server";
import { getChurnView } from "~/lib/intelligence/trends.server";
import { listCustomerDirectory, listCustomerTiers } from "~/lib/intelligence/directory.server";
import {
  getFailedPaymentDetail,
  getGlobalPaymentStatusCounts,
  listFilteredFailedPayments,
  type FailedPaymentPageSize,
  type RecoveryStepRow,
} from "~/lib/recovery/queries.server";
import { readAccountAuditSettings } from "~/lib/settings/audit-settings.server";
import {
  applyAlertConfig,
  applyAlertCreate,
  applyAuditSettings,
  applyBrandVoice,
  applyFeatureSettings,
  applyIntelligenceContext,
  applyNotificationSettings,
  applySenderName,
  type NotificationSettingsState,
} from "~/lib/settings/apply.server";
import {
  getAccount,
  getMerchantContext,
  getPrimaryBrandVoices,
  getPrimarySenderConnection,
  listAccountConnections,
} from "~/lib/settings/queries.server";

import { CONFIRM_ARGUMENT, CONFIRM_PROPERTY, CONFIRM_RESULT_FIELDS, confirmationNeeded } from "./confirm.server";
import {
  defineToolRegistry,
  type McpTool,
  type McpToolAnnotations,
  type McpToolContext,
  type McpToolRegistry,
  ToolInputError,
} from "./registry";

// THE MERCHANT TOOLS, REGROUPED TO THE 2026-10-10 MCP RULING.
//
// Twenty-three one-endpoint tools became twelve whole-job ones (rule 3: 5 to 15
// per server; rule 4: outcomes, not API mirrors), each named
// foxhound_{action}_{resource} (rule 5) and carrying all four behavior hints
// set honestly (rule 6). Ten read and two write. Read and write are never
// merged into one tool, so a read never carries a write's hints and a client
// never has to confirm a read. The design is capsid/research/design-mcp-servers.md
// section 5; its optional twelfth, foxhound_stage_recovery_action, is left out
// because no pending-actions table exists, and foxhound_get_settings takes its
// place so every writer still has a reader (375's argument, below).
//
// THE ACCOUNT COMES FROM THE KEY AND NOWHERE ELSE. Each executor receives the
// account the bearer token resolved to and passes it to the helper. No tool
// takes an account id as an argument.
//
// EVERY ID AN AGENT PASSES IS PROVED TO BE THIS ACCOUNT'S (rule 12.1). The
// helpers each pin the account in their own predicate (payment, customer, audit
// run, connection, alert), so another merchant's id reads as "not found" rather
// than as their row. test/mcp-ownership-rule12.test.ts plants another
// merchant's real row behind every id-taking argument and fails if any tool
// returns or changes it. Recova's trigger_immediate_retry, which inserted a
// retry for any failed_payment_id it was handed, is the hole that test exists
// to keep out.
//
// NO MONEY TOOL EXISTS HERE, and none will: the HUMAN-FOREVER denylist in
// ./registry.ts refuses one at construction. Every helper below is a SELECT or
// one of the settings writers the app's own forms call; nothing imports
// `executeMoneyWrite`, `recordOutcome`, a billing writer or a dispute writer.
//
// REDACTION IS DEFAULT-ON FOR EVERY TOOL, AND NOT ONE LINE OF IT IS IN THIS
// FILE. Registering a tool is what redacts it; see ./redact.ts. A
// tool's job is to choose WHICH fields to return, never to disguise one.

type ToolArgs = Record<string, unknown>;

/**
 * A tool's outputSchema (area 11, T3): an object naming its top-level fields,
 * with `required` only those that are always present (a lookup that may come
 * back empty is not required, since a missing required field would turn a
 * good answer into an error). The fields themselves are left open, so the
 * schema says what an answer holds without pinning every nested shape.
 * The SDK checks each successful result against it.
 */
function result(fields: string[], required: string[] = fields) {
  return {
    type: "object" as const,
    properties: Object.fromEntries(fields.map((field) => [field, {}])),
    required,
  };
}

/** Every read: changes nothing, safe to repeat, touches nothing outside Foxhound. */
const READ: McpToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};


function stringArg(args: ToolArgs, name: string): string | null {
  const raw = args[name];
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

function required(args: ToolArgs, name: string, from: string): string {
  const value = stringArg(args, name);
  if (value === null) throw new ToolInputError(`Missing required argument ${name}. ${from}`);
  return value;
}

// ---------------------------------------------------------------------------
// Pagination (rule 7)
// ---------------------------------------------------------------------------
//
// ONE SHAPE EVERYWHERE: a list takes an optional `cursor` and answers with
// `has_more` and `next_cursor` (null on the last page). The cursor is opaque to
// the agent and names the tool it came from, so a cursor from one list handed
// to another is refused with a sentence rather than read as a page number.
// It carries a position and nothing else: the account still comes from the key
// on every page, so a cursor cannot widen what a page may read.

const CURSOR_PROPERTY = {
  type: "string",
  description: "Omit for the first page. To read on, pass next_cursor from the previous answer.",
} as const;

function encodeCursor(tool: string, page: number): string {
  return btoa(JSON.stringify({ t: tool, p: page })).replace(/=+$/, "");
}

/** The 1-based page a cursor names, or 1 when there is none. */
function decodeCursor(tool: string, args: ToolArgs): number {
  const raw = args["cursor"];
  if (raw === undefined || raw === null || raw === "") return 1;
  const refusal = new ToolInputError(
    `That cursor was not issued by ${tool}. Omit cursor to start from the first page.`,
  );
  if (typeof raw !== "string") throw refusal;
  let parsed: unknown;
  try {
    parsed = JSON.parse(atob(raw));
  } catch {
    throw refusal;
  }
  const { t, p } = (parsed ?? {}) as { t?: unknown; p?: unknown };
  if (t !== tool || typeof p !== "number" || !Number.isInteger(p) || p < 1) throw refusal;
  return p;
}

function pageInfo(tool: string, page: number, totalPages: number) {
  const hasMore = page < totalPages;
  return { has_more: hasMore, next_cursor: hasMore ? encodeCursor(tool, page + 1) : null };
}

/** One page of an in-memory list the helper already scoped to the account. */
function slicePage<T>(tool: string, rows: T[], page: number, pageSize: number) {
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const items = rows.slice((page - 1) * pageSize, page * pageSize);
  return { items, total: rows.length, ...pageInfo(tool, page, totalPages) };
}

/**
 * What a dispute looks like on the wire, and why it is a PICK rather than a row.
 *
 * `listDisputes` is `db.select()` over a 60-column table, and that table holds
 * far more about a customer than the two fields 370 ruled on: `customerIp`,
 * `billingAddress`, the model-written `aiResponseText` and `triageReasoning`,
 * and four JSON blobs including `priorChargesJson` and `recoveryEmailsJson`,
 * which carry the customer's purchase history and the text of mail Foxhound
 * sent them.
 *
 * 383 SPLIT THAT LIST, and this comment is corrected rather than left standing.
 * `customerIp` and `billingAddress` ARE redacted at the boundary now, so the
 * sentence that used to sit here, that the redactor could not help with any of
 * it, was true when written and is false today. The projection stays as DEFENSE
 * IN DEPTH on those two and remains the ONLY cover for the rest, because 383
 * deliberately declined to redact purchase history and Foxhound's own generated
 * text: those are facts about the merchant's relationship with a customer rather
 * than about the person, and nulling them would be deciding what a merchant may
 * read about their own business.
 *
 * SO THE FIX IS AT THE OTHER END. The tool returns the fields an agent needs to
 * reason about a dispute (what it is, what it is worth, where it stands, when it
 * is due, what it will cost) and the raw row never reaches the boundary at all.
 * The customer id comes through whole, as everywhere else on this endpoint, so a
 * follow-up question is still possible.
 *
 * THIS IS AN ALLOWLIST AND IT IS MEANT TO BE. A new column added to `disputes`
 * next year does not appear here, which is the correct default for a table this
 * one is a window onto: a new column reaches an agent when somebody decides it
 * should, not because it was added.
 *
 * `customerEmail` IS LISTED, deliberately, and arrives masked from the boundary.
 * Dropping it instead would be this file quietly deciding a field 370 ruled
 * VISIBLE-BUT-MASKED should be invisible, and would leave the endpoint with no
 * way to correlate a dispute to a customer an agent has already seen elsewhere.
 */
function disputeForAgent(row: DisputeRow) {
  return {
    id: row.id,
    stripeDisputeId: row.stripeDisputeId,
    stripeChargeId: row.stripeChargeId,
    stripeCustomerId: row.stripeCustomerId,
    customerEmail: row.customerEmail,
    amountCents: row.amountCents,
    currency: row.currency,
    reason: row.reason,
    status: row.status,
    state: row.state,
    outcome: row.outcome,
    outcomeAmountCents: row.outcomeAmountCents,
    evidenceDeadline: row.evidenceDeadline,
    submittedAt: row.submittedAt,
    resolvedAt: row.resolvedAt,
    createdAt: row.createdAt,
    smartDisputesStatus: row.smartDisputesStatus,
    triageRecommendation: row.triageRecommendation,
    triageConfidence: row.triageConfidence,
    resolvedFeeCents: row.resolvedFeeCents,
    resolvedFeeCurrency: row.resolvedFeeCurrency,
    resolvedFeeError: row.resolvedFeeError,
  };
}

/**
 * A recovery step on the wire, as a PICK for the same reason disputes are one.
 * The row carries the email Foxhound wrote to the customer (`aiSubject`,
 * `aiBodyHtml`, `customBody`), which greets them by name, and the send error
 * text, which can carry their address. 383 keeps Foxhound's generated text off
 * the wire at the tool rather than in the redactor, so the tool returns what an
 * agent needs to reason about the sequence (what ran, when, what happened, how
 * the customer engaged) and never the letter itself.
 */
function stepForAgent(row: RecoveryStepRow) {
  return {
    id: row.id,
    stepType: row.stepType,
    stepNumber: row.stepNumber,
    scheduledAt: row.scheduledAt,
    executedAt: row.executedAt,
    result: row.result,
    retryResult: row.retryResult,
    attemptCount: row.attemptCount,
    nextRetryAt: row.nextRetryAt,
    openedAt: row.openedAt,
    clickedAt: row.clickedAt,
    emailOpenedCount: row.emailOpenedCount,
    emailClickedCount: row.emailClickedCount,
    abVariant: row.abVariant,
  };
}

// ---------------------------------------------------------------------------
// The ten reads
// ---------------------------------------------------------------------------

const PAYMENT_PAGE_SIZES = [10, 25, 50, 100] as const;
const DISPUTE_PAGE_SIZE = 25;
const AUDIT_RUN_PAGE_SIZE = 12;
/** The audit-run history the helper is asked for. It takes a limit, not an
 *  offset, so pages are cut from this many of the newest runs. */
const AUDIT_RUN_HISTORY_LIMIT = 120;

function paymentPageSize(args: ToolArgs): FailedPaymentPageSize {
  const raw = args["page_size"];
  if (raw === undefined) return 25;
  if (typeof raw === "number" && (PAYMENT_PAGE_SIZES as readonly number[]).includes(raw)) {
    return raw as FailedPaymentPageSize;
  }
  throw new ToolInputError(`page_size must be one of ${PAYMENT_PAGE_SIZES.join(", ")}.`);
}

const READ_TOOLS: McpTool[] = [
  {
    name: "foxhound_get_overview",
    title: "Account overview",
    description:
      "Start here. Read this account's recurring-revenue overview (MRR, movement, customer counts, the latest report summary), the failed-payment counts by recovery status, and the Stripe accounts connected to it. Access tokens are never returned, and nothing can be connected or disconnected here.",
    inputSchema: { type: "object", additionalProperties: false, properties: {}, required: [] },
    outputSchema: result(["overview", "payment_status_counts", "connections"], []),
    annotations: READ,
    scope: "read",
    execute: async (ctx) => {
      const [overview, payment_status_counts, connections] = await Promise.all([
        getIntelligenceOverview(ctx.db, ctx.accountId, { forAgent: true }),
        getGlobalPaymentStatusCounts(ctx.db, ctx.accountId),
        listAccountConnections(ctx.db, ctx.accountId),
      ]);
      return { overview, payment_status_counts, connections };
    },
  },
  {
    name: "foxhound_list_payments",
    title: "List failed payments",
    description:
      "List this account's failed payments, newest first, with amount, decline category and recovery status. Filter by status or decline category. Paginated: pass next_cursor back to read on. Customer emails are masked and no name is returned. Use foxhound_get_payment with an id from here for one payment's recovery steps.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        status: {
          type: "string",
          description: "Only payments in this recovery status, for example active, recovered, failed or canceled.",
        },
        decline_category: {
          type: "string",
          description: "Only payments with this decline category, for example soft, expired, network or fraud.",
        },
        page_size: { type: "integer", enum: [...PAYMENT_PAGE_SIZES], description: "Rows per page. Defaults to 25." },
        cursor: CURSOR_PROPERTY,
      },
      required: [],
    },
    outputSchema: result(["payments", "total", "has_more", "next_cursor"], ["payments", "has_more"]),
    annotations: READ,
    scope: "read",
    execute: async (ctx, args) => {
      const tool = "foxhound_list_payments";
      const page = decodeCursor(tool, args);
      const pageSize = paymentPageSize(args);
      const result = await listFilteredFailedPayments(ctx.db, ctx.accountId, {
        search: null,
        declineCategory: stringArg(args, "decline_category"),
        detectedAfterMs: null,
        amountMinCents: null,
        amountMaxCents: null,
        status: stringArg(args, "status"),
        sort: "newest",
        page,
        pageSize,
      });
      // The helper clamps a page past the end back to the last page, which is
      // right for a screen and wrong for a cursor: past the end is empty.
      const payments = page > result.totalPages ? [] : result.payments;
      return { payments, total: result.totalCount, ...pageInfo(tool, page, result.totalPages) };
    },
  },
  {
    name: "foxhound_get_payment",
    title: "Get one failed payment",
    description:
      "Read one of this account's failed payments with its recovery steps in order (what ran, when and how the customer engaged; never the email text), the recovery if there was one, the same customer's previous failures and any open disputes. Payment ids come from foxhound_list_payments. Cannot retry, pause, resume or cancel recovery; that stays in the Foxhound app.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { payment_id: { type: "string", description: "The failed payment's id, from foxhound_list_payments." } },
      required: ["payment_id"],
    },
    outputSchema: result(["steps"]),
    annotations: READ,
    scope: "read",
    execute: async (ctx, args) => {
      const paymentId = required(args, "payment_id", "Take one from foxhound_list_payments.");
      const detail = await getFailedPaymentDetail(ctx.db, ctx.accountId, paymentId);
      if (!detail) {
        throw new ToolInputError(
          `No failed payment ${paymentId} on this account. Take an id from foxhound_list_payments.`,
        );
      }
      return { ...detail, steps: detail.steps.map(stepForAgent) };
    },
  },
  {
    name: "foxhound_list_customers",
    title: "List customers",
    description:
      "List this account's customers with health score, plan tier and MRR, lowest health first, plus the plan tiers present. tier filters to one plan tier. Paginated, 50 a page: pass next_cursor back to read on. Names are never returned and emails are masked; the Stripe customer id is the key for foxhound_get_customer.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        tier: { type: "string", description: "Only customers on this plan tier, as listed in tiers." },
        cursor: CURSOR_PROPERTY,
      },
      required: [],
    },
    outputSchema: result(["customers", "total", "total_mrr_cents", "tiers", "has_more", "next_cursor"], ["customers", "has_more"]),
    annotations: READ,
    scope: "read",
    execute: async (ctx, args) => {
      const tool = "foxhound_list_customers";
      const page = decodeCursor(tool, args);
      const [result, tiers] = await Promise.all([
        // NO SEARCH, on purpose: the directory's search matches customer names,
        // so a search argument would let an agent confirm a guessed name the
        // redactor never sends. A customer is found by tier or by paging.
        listCustomerDirectory(ctx.db, ctx.accountId, {
          search: null,
          tier: stringArg(args, "tier"),
          healthBand: null,
          sort: "health_asc",
          page,
        }),
        listCustomerTiers(ctx.db, ctx.accountId),
      ]);
      const customers = page > result.totalPages ? [] : result.customers;
      return {
        customers,
        total: result.totalCount,
        total_mrr_cents: result.totalMrrCents,
        tiers,
        ...pageInfo(tool, page, result.totalPages),
      };
    },
  },
  {
    name: "foxhound_get_customer",
    title: "Get one customer",
    description:
      "Read one of this account's customers: health score, its factors, its history and the churn predictions, with when they became a customer, their current plan name and tier, monthly MRR contribution and lifetime value (null until Foxhound computes it). The name is never returned and the email is masked. Customer ids come from foxhound_list_customers.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        stripe_customer_id: { type: "string", description: "The Stripe customer id, from foxhound_list_customers." },
      },
      required: ["stripe_customer_id"],
    },
    outputSchema: result(["customer"], []),
    annotations: READ,
    scope: "read",
    execute: async (ctx, args) => {
      const customerId = required(args, "stripe_customer_id", "Take one from foxhound_list_customers.");
      const customer = await getCustomerHealthDetail(ctx.db, ctx.accountId, customerId);
      if (!customer) {
        throw new ToolInputError(
          `No customer ${customerId} on this account. Take an id from foxhound_list_customers.`,
        );
      }
      return { customer };
    },
  },
  {
    name: "foxhound_get_intelligence",
    title: "Churn and alerts",
    description:
      "Read this account's subscription intelligence: churn bands, the churn chart series, the highest-risk customers, and the metric alerts with their recent firings. Alert ids from here are the ones foxhound_manage_alerts takes.",
    inputSchema: { type: "object", additionalProperties: false, properties: {}, required: [] },
    outputSchema: result(["churn", "alerts", "alert_history"], []),
    annotations: READ,
    scope: "read",
    execute: async (ctx) => {
      const [churn, alerts] = await Promise.all([
        getChurnView(ctx.db, ctx.accountId, ctx.now.getTime()),
        getAlertsView(ctx.db, ctx.accountId),
      ]);
      return { churn, alerts: alerts.alerts, alert_history: alerts.history };
    },
  },
  {
    name: "foxhound_list_disputes",
    title: "List disputes",
    description:
      "List this account's disputes, newest first, with state, amount, evidence deadline and triage recommendation. Paginated, 25 a page: pass next_cursor back to read on. Read only: cannot submit evidence, approve a submission or accept a dispute; those stay in the Foxhound app.",
    inputSchema: { type: "object", additionalProperties: false, properties: { cursor: CURSOR_PROPERTY }, required: [] },
    outputSchema: result(["disputes", "total", "has_more", "next_cursor"], ["disputes", "has_more"]),
    annotations: READ,
    scope: "read",
    execute: async (ctx, args) => {
      const tool = "foxhound_list_disputes";
      const page = decodeCursor(tool, args);
      const rows = await listDisputes(ctx.db, ctx.accountId);
      const { items, ...rest } = slicePage(tool, rows, page, DISPUTE_PAGE_SIZE);
      return { disputes: items.map(disputeForAgent), ...rest };
    },
  },
  {
    name: "foxhound_review_audits",
    title: "Review audits",
    description:
      "Read this account's audit settings and its stored audit runs, newest first, with each scope's figures or null where a scope could not be read. Pass run_id for one run in full. Paginated, 12 a page: pass next_cursor back to read on.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        run_id: { type: "string", description: "One audit run's id, from an earlier answer. Omit to list runs." },
        cursor: CURSOR_PROPERTY,
      },
      required: [],
    },
    outputSchema: result(["run", "settings", "runs", "total", "has_more", "next_cursor"], []),
    annotations: READ,
    scope: "read",
    execute: async (ctx, args) => {
      const tool = "foxhound_review_audits";
      const runId = stringArg(args, "run_id");
      if (runId !== null) {
        const row = await getAuditRun(ctx.db, ctx.accountId, runId);
        if (!row) {
          throw new ToolInputError(
            `No audit run ${runId} on this account. Omit run_id to list this account's runs.`,
          );
        }
        return { run: toStoredAuditRun(row) };
      }
      const page = decodeCursor(tool, args);
      const [settings, rows] = await Promise.all([
        readAccountAuditSettings(ctx.db, ctx.accountId),
        listAuditRuns(ctx.db, ctx.accountId, AUDIT_RUN_HISTORY_LIMIT),
      ]);
      const { items, ...rest } = slicePage(tool, rows, page, AUDIT_RUN_PAGE_SIZE);
      return { settings, runs: items.map(toStoredAuditRun), ...rest };
    },
  },
  {
    name: "foxhound_get_billing",
    title: "Foxhound billing",
    description:
      "Read this account's own Foxhound billing: the attributed-recovery ledger, past invoices and the next billing run's preview. Read only: cannot issue, pay, adjust or void anything.",
    inputSchema: { type: "object", additionalProperties: false, properties: {}, required: [] },
    outputSchema: result(["ledger", "invoices", "preview"], []),
    annotations: READ,
    scope: "read",
    execute: async (ctx) => {
      const [ledger, invoices, preview] = await Promise.all([
        getBillingLedger(ctx.db, ctx.accountId),
        listBillingInvoices(ctx.db, ctx.accountId),
        getBillingPreview(ctx.db, ctx.accountId, ctx.now.getTime()),
      ]);
      return { ledger, invoices, preview };
    },
  },
  // THE READER FOR EVERY SETTING foxhound_update_settings WRITES (375's
  // argument, kept): a writer an agent cannot read first forces it to guess or
  // to ask the merchant to paste the current value in. Each section returns
  // the fields its writer section takes, so read-then-write round-trips.
  {
    name: "foxhound_get_settings",
    title: "Read settings",
    description:
      "Read every setting foxhound_update_settings can change: audit window, the two engine toggles, notification email and toggles, the connected Stripe accounts, the primary connection's sender name and brand voice, and the business context the email writer is given. The Slack webhook URL is never returned, only whether one is set.",
    inputSchema: { type: "object", additionalProperties: false, properties: {}, required: [] },
    outputSchema: result(["audit", "features", "notifications", "connections", "sender", "brand_voice", "intelligence_context"], ["features", "notifications"]),
    annotations: READ,
    scope: "read",
    execute: async (ctx) => {
      const [account, audit, connections, sender, voices, intelligence_context] = await Promise.all([
        getAccount(ctx.db, ctx.accountId),
        readAccountAuditSettings(ctx.db, ctx.accountId),
        listAccountConnections(ctx.db, ctx.accountId),
        getPrimarySenderConnection(ctx.db, ctx.accountId),
        getPrimaryBrandVoices(ctx.db, ctx.accountId),
        getMerchantContext(ctx.db, ctx.accountId),
      ]);
      // The voice samples are left out: they are the merchant's past emails to
      // customers, greeting them by name, kept as one JSON string the field
      // redactor cannot see into, and no writer here takes them back.
      const brand_voice =
        voices === null
          ? null
          : {
              id: voices.id,
              general: voices.general,
              soft: voices.soft,
              expired: voices.expired,
              network: voices.network,
              fraud: voices.fraud,
            };
      return {
        audit,
        features: {
          winbackNotificationsEnabled: account?.winbackNotificationsEnabled ?? null,
          expiringCardNotificationsEnabled: account?.expiringCardNotificationsEnabled ?? null,
        },
        notifications: {
          notificationEmail: account?.notificationEmail ?? null,
          slackWebhookConfigured: Boolean(account?.slackWebhookUrl),
          slackNotificationsEnabled: account?.slackNotificationsEnabled ?? null,
          digestEnabled: account?.digestEnabled ?? null,
          recoveryNotificationsEnabled: account?.recoveryNotificationsEnabled ?? null,
          sequenceCompleteNotificationsEnabled: account?.sequenceCompleteNotificationsEnabled ?? null,
        },
        connections,
        sender,
        brand_voice,
        intelligence_context,
      };
    },
  },
];

// ---------------------------------------------------------------------------
// The two writes (372's item-4 ruling, eight writers folded into two tools)
// ---------------------------------------------------------------------------
//
// EVERY WRITE GOES THROUGH THE FORM'S OWN CODE PATH. Each section calls the same
// `applyX` the route action calls: same bounds, same allowlist, same refusal
// STRING, one implementation.
//
// EVERY WRITE LEAVES A TRACE. The tool passes a `WriteTrace` carrying the api
// key id and this tool's name, and the trace row goes in the SAME batch as the
// write, so a change without its trace is not a state the database can reach.
//
// ONE SECTION PER CALL. Each section is one form's batch, so a call that named
// two would be two commits, and a refusal in the second would leave the first
// applied with no way for the agent to tell from one answer. Requiring exactly
// one keeps every call all-or-nothing.

/** Turn an apply result into a tool response, or a tool error carrying the
 *  form's own refusal string. */
function applied<T>(
  result: { ok: true; fields: string[]; state: T } | { ok: false; error: string },
): { updated: string[]; state: T } {
  if (!result.ok) throw new ToolInputError(result.error);
  return { updated: result.fields, state: result.state };
}

/** Copy only the keys the agent sent, renamed, so an omitted key stays
 *  omitted. Writing `{ general: args.general ?? "" }` would clear the column on
 *  every call that left it out, which for a voice set once and never touched
 *  again would be silent and unrecoverable. */
function sentOnly(section: ToolArgs, names: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [from, to] of Object.entries(names)) {
    if (section[from] !== undefined) out[to] = section[from];
  }
  return out;
}

function withoutWebhookUrl(
  result: Parameters<typeof applied<NotificationSettingsState>>[0],
) {
  const { updated, state } = applied(result);
  const { slackWebhookUrl, ...rest } = state;
  return { updated, state: { ...rest, slackWebhookConfigured: Boolean(slackWebhookUrl) } };
}

/**
 * Refuse a connection id that is not this account's, in words an agent can act
 * on, before the writer runs.
 *
 * The writers prove ownership themselves (rule 12.1) and refuse a foreign id
 * with the settings form's sentence, "Connect Stripe before setting a sender
 * name.", which is right for a person with no connection and misleading for an
 * agent that sent an id it should not have. This check says what is wrong and
 * where a good id comes from. It is the second check, not the only one: the
 * writer's own predicate still stands behind it.
 */
async function requireOwnConnection(ctx: McpToolContext, section: ToolArgs): Promise<void> {
  const connectionId = section.connection_id;
  if (typeof connectionId !== "string" || connectionId.length === 0) return;
  const own = await listAccountConnections(ctx.db, ctx.accountId);
  if (!own.some((connection) => connection.id === connectionId)) {
    throw new ToolInputError(
      `Connection ${connectionId} is not one of this account's Stripe connections. Take a connection id from foxhound_get_settings.`,
    );
  }
}

type SettingsSection = (ctx: McpToolContext, section: ToolArgs) => Promise<unknown>;

const SETTINGS_SECTIONS: Record<string, SettingsSection> = {
  audit: async (ctx, s) =>
    applied(
      await applyAuditSettings(
        ctx.db,
        ctx.accountId,
        { lookbackDays: s.lookback_days, autoRun: s.auto_run },
        ctx.trace,
      ),
    ),
  features: async (ctx, s) =>
    applied(
      await applyFeatureSettings(
        ctx.db,
        ctx.accountId,
        {
          winbackNotificationsEnabled: s.winback_notifications_enabled,
          expiringCardNotificationsEnabled: s.expiring_card_notifications_enabled,
        },
        ctx.trace,
      ),
    ),
  // The webhook URL is a credential for the merchant's Slack, so the answer
  // says whether one is set, as foxhound_get_settings does, and never echoes it.
  notifications: async (ctx, s) =>
    withoutWebhookUrl(
      await applyNotificationSettings(
        ctx.db,
        ctx.accountId,
        {
          notificationEmail: s.notification_email,
          slackWebhookUrl: s.slack_webhook_url ?? "",
          slackNotificationsEnabled: s.slack_notifications_enabled,
          digestEnabled: s.digest_enabled,
          recoveryNotificationsEnabled: s.recovery_notifications_enabled,
          sequenceCompleteNotificationsEnabled: s.sequence_complete_notifications_enabled,
        },
        ctx.trace,
      ),
    ),
  sender_name: async (ctx, s) => {
    await requireOwnConnection(ctx, s);
    return applied(
      await applySenderName(
        ctx.db,
        ctx.accountId,
        { connectionId: s.connection_id, senderName: s.sender_name },
        ctx.trace,
      ),
    );
  },
  // This text lands in the system prompt that writes the merchant's recovery
  // emails. It is not sanitized on the way in, exactly as the form does not
  // sanitize it: `sanitizeCopy` and `passesQualityGate` run on what comes out.
  brand_voice: async (ctx, s) => {
    await requireOwnConnection(ctx, s);
    return applied(
      await applyBrandVoice(
        ctx.db,
        ctx.accountId,
        {
          connectionId: s.connection_id,
          ...sentOnly(s, { general: "general", soft: "soft", expired: "expired", network: "network", fraud: "fraud" }),
        },
        ctx.trace,
      ),
    );
  },
  intelligence_context: async (ctx, s) =>
    applied(
      await applyIntelligenceContext(
        ctx.db,
        ctx.accountId,
        sentOnly(s, {
          merchant_industry: "merchantIndustry",
          primary_customer_type: "primaryCustomerType",
          merchant_mrr_self_reported: "merchantMrrSelfReported",
        }),
        ctx.trace,
      ),
    ),
};

const SECTION_NAMES = Object.keys(SETTINGS_SECTIONS);

/** What a settings call would do, in words the merchant can approve. A Slack
 *  webhook URL is a credential, so it is named, never shown. */
function describeSettingsChange(name: string, section: ToolArgs): string {
  const shown = Object.entries(section).map(([field, value]) =>
    field === "slack_webhook_url" ? `${field}: ${value ? "a new Slack webhook URL" : "cleared"}` : `${field}: ${JSON.stringify(value)}`,
  );
  const cleared = name === "notifications" && section.slack_webhook_url === undefined ? ["slack_webhook_url: cleared"] : [];
  return `Overwrite the ${name} settings with ${[...shown, ...cleared].join(", ") || "nothing"}.${
    name === "notifications" ? " Every notification field is replaced, and clearing the email turns every notification off." : ""
  }`;
}

const ALERT_ACTIONS = ["create", "enable", "disable", "delete"] as const;

const WRITE_TOOLS: McpTool[] = [
  {
    name: "foxhound_update_settings",
    title: "Change settings",
    description:
      "Change one group of this account's settings per call: send exactly one of audit, features, notifications, sender_name, brand_voice or intelligence_context. Read the current values first with foxhound_get_settings. Values overwrite what is there: in notifications every field is replaced and an omitted Slack webhook is cleared; in brand_voice and intelligence_context an omitted field is left alone and an empty string clears it. Connection ids come from foxhound_get_settings and must belong to this account. Every change is confirmed first: the first call changes nothing and answers what it would change and a confirm code; show that to the merchant and call again with the same arguments and confirm only if they say yes.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        audit: {
          type: "object",
          description: "The audit window and the monthly audit report.",
          properties: {
            lookback_days: { type: "integer", description: "30, 60, 90 or 180. Other values clamp." },
            auto_run: { type: "boolean", description: "Send the monthly audit report." },
          },
          required: ["lookback_days", "auto_run"],
        },
        features: {
          type: "object",
          description: "Switch the win-back and expiring-card engines on or off (the engines, not the notifications about them).",
          properties: {
            winback_notifications_enabled: { type: "boolean" },
            expiring_card_notifications_enabled: { type: "boolean" },
          },
          required: ["winback_notifications_enabled", "expiring_card_notifications_enabled"],
        },
        notifications: {
          type: "object",
          description: "Notification email, Slack webhook and the four notification toggles. Every field is replaced. Clearing the email turns every notification off.",
          properties: {
            notification_email: { type: "string", description: "Empty or omitted clears it." },
            slack_webhook_url: {
              type: "string",
              description: "Must be on https://hooks.slack.com/. Empty or omitted clears it; send it again to keep it.",
            },
            slack_notifications_enabled: { type: "boolean" },
            digest_enabled: { type: "boolean" },
            recovery_notifications_enabled: { type: "boolean" },
            sequence_complete_notifications_enabled: { type: "boolean" },
          },
          required: [],
        },
        sender_name: {
          type: "object",
          description: "The From name on one connection's recovery emails.",
          properties: {
            connection_id: { type: "string", description: "From foxhound_get_settings." },
            sender_name: { type: "string", description: "Up to 80 characters. Empty clears it and mail goes out from Support." },
          },
          required: ["connection_id"],
        },
        brand_voice: {
          type: "object",
          description: "The tone Foxhound writes one connection's recovery emails in: free-form guidance for the writer, not a template.",
          properties: {
            connection_id: { type: "string", description: "From foxhound_get_settings." },
            general: { type: "string", description: "The voice for every category with no override." },
            soft: { type: "string", description: "Soft declines: insufficient funds and the like." },
            expired: { type: "string", description: "Expired card." },
            network: { type: "string", description: "Network and issuer declines." },
            fraud: { type: "string", description: "Suspected fraud." },
          },
          required: ["connection_id"],
        },
        intelligence_context: {
          type: "object",
          description: "What kind of business this is. The recovery-email writer is given these.",
          properties: {
            merchant_industry: { type: "string", description: 'For example "B2B SaaS".' },
            primary_customer_type: { type: "string", description: 'For example "small businesses".' },
            merchant_mrr_self_reported: {
              type: ["number", "string"],
              description:
                "US dollars, not cents. foxhound_get_settings reports it in cents as merchantMrrSelfReportedCents, so divide by 100 before sending it back. Empty clears it.",
            },
          },
          required: [],
        },
        [CONFIRM_ARGUMENT]: CONFIRM_PROPERTY,
      },
      required: [],
    },
    // Destructive because a value is overwritten, and clearing the notification
    // email silences every notification, so it is confirmed first
    // (./confirm.server.ts). Idempotent because the same call twice leaves the
    // same settings.
    outputSchema: result(["section", "updated", "state", ...CONFIRM_RESULT_FIELDS, "note"], []),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    scope: "write",
    execute: async (ctx, args) => {
      const sent = SECTION_NAMES.filter((name) => args[name] !== undefined);
      if (sent.length !== 1) {
        throw new ToolInputError(
          `Send exactly one of ${SECTION_NAMES.join(", ")}; this call sent ${sent.length === 0 ? "none" : sent.join(" and ")}. Make one call per group.`,
        );
      }
      const name = sent[0];
      const section = args[name];
      if (!section || typeof section !== "object" || Array.isArray(section)) {
        throw new ToolInputError(`${name} must be an object of that group's fields.`);
      }
      const pending = await confirmationNeeded(ctx, "foxhound_update_settings", args, describeSettingsChange(name, section as ToolArgs));
      if (pending) return pending;
      return { section: name, ...((await SETTINGS_SECTIONS[name](ctx, section as ToolArgs)) as object) };
    },
  },
  {
    name: "foxhound_manage_alerts",
    title: "Manage alerts",
    // DELETION IS NAMED rather than left to be discovered, because it takes the
    // alert's firing history with it and that is not recoverable.
    description:
      "Create, enable, disable or delete one of this account's metric alerts. action create takes metric, direction and threshold (dollars for amount metrics, a percent for the recovery rate, a plain count otherwise), an optional label and an optional channel (email, the default, or slack); enable, disable and delete take alert_id from foxhound_get_intelligence, which must belong to this account. Deleting also removes that alert's recorded breaches. A breach is recorded in the app and sent to the alert's channel at most once a day. delete is confirmed first: the first call deletes nothing and answers what it would delete and a confirm code; show that to the merchant and call again with the same arguments and confirm only if they say yes.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: { type: "string", enum: [...ALERT_ACTIONS], description: "What to do." },
        alert_id: { type: "string", description: "For enable, disable and delete: from foxhound_get_intelligence." },
        metric: { type: "string", description: "For create: one of the metrics foxhound_get_intelligence reports." },
        direction: { type: "string", description: "For create: whether the metric rising or dropping fires." },
        threshold: {
          type: ["number", "string"],
          description: "For create: dollars for amount metrics, a plain count otherwise.",
        },
        label: { type: "string", description: "For create: an optional name for the alert." },
        channel: { type: "string", enum: ["email", "slack"], description: "For create: where a breach is sent. Defaults to email." },
        [CONFIRM_ARGUMENT]: { ...CONFIRM_PROPERTY, description: `For delete. ${CONFIRM_PROPERTY.description}` },
      },
      required: ["action"],
    },
    // Destructive because delete is, so delete is confirmed first
    // (./confirm.server.ts); not idempotent because create makes a new alert
    // each time.
    outputSchema: result(["action", "updated", "state", ...CONFIRM_RESULT_FIELDS, "note"], []),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    scope: "write",
    execute: async (ctx, args) => {
      const action = args["action"];
      if (action === "create") {
        if (args["alert_id"] !== undefined) {
          throw new ToolInputError("create makes a new alert and takes no alert_id. Drop alert_id, or use enable, disable or delete.");
        }
        return {
          action,
          ...applied(
            await applyAlertCreate(
              ctx.db,
              ctx.accountId,
              { metric: args.metric, direction: args.direction, threshold: args.threshold, label: args.label, channel: args.channel },
              ctx.now,
              ctx.trace,
            ),
          ),
        };
      }
      if (action === "enable" || action === "disable" || action === "delete") {
        const alertId = required(args, "alert_id", "Take one from foxhound_get_intelligence.");
        if (action === "delete") {
          const pending = await confirmationNeeded(
            ctx,
            "foxhound_manage_alerts",
            args,
            `Delete alert ${alertId} and every breach recorded for it. This cannot be undone.`,
          );
          if (pending) return pending;
        }
        return {
          action,
          ...applied(
            await applyAlertConfig(
              ctx.db,
              ctx.accountId,
              { alertId: args.alert_id, enabled: action === "enable", deleted: action === "delete" },
              ctx.trace,
            ),
          ),
        };
      }
      throw new ToolInputError(`action must be one of ${ALERT_ACTIONS.join(", ")}.`);
    },
  },
];

/** The live registry. Built through `defineToolRegistry`, so the HUMAN-FOREVER
 *  denylist and the name rule run over every name at module load, and every
 *  executor is wrapped in the redactor at the same moment. */
export const MERCHANT_TOOLS: McpToolRegistry = defineToolRegistry([...READ_TOOLS, ...WRITE_TOOLS]);

/** The tool names, exported so a plant can assert the set without re-listing it. */
export const MERCHANT_TOOL_NAMES = [...READ_TOOLS, ...WRITE_TOOLS].map((t) => t.name);
/** The write half, named so a plant can assert exactly these carry a trace. */
export const MERCHANT_WRITE_TOOL_NAMES = WRITE_TOOLS.map((t) => t.name);

