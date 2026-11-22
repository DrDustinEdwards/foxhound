import { getAuditRun, listAuditRuns } from "~/lib/audit/persist.server";
import { toStoredAuditRun } from "~/lib/audit/render";
import { getBillingPreview } from "~/lib/billing/preview.server";
import type { EnrichedLineItem } from "~/lib/billing/queries.server";
import {
  getBillingInvoiceDetail,
  getBillingLedger,
  listBillingInvoices,
} from "~/lib/billing/queries.server";
import { getRecoveryStats } from "~/lib/dashboard/stats.server";
import {
  getDisputeDetail,
  listDisputesPage,
  readDisputeAutoSubmit,
  readDisputeSettings,
  type DisputeRow,
} from "~/lib/disputes/queries.server";
import {
  getAlertsView,
  getCustomerHealthDetail,
  getIntelligenceOverview,
  getReportsArchive,
} from "~/lib/intelligence/views.server";
import {
  listActionableRecommendations,
  RECOMMENDATIONS_PAGE_SIZE,
} from "~/lib/intelligence/recommendations.server";
import { DISPUTE_AUTO_SUBMIT_HOURS } from "~/lib/disputes/approval";
import { isCardExpired, isCardExpiringSoon } from "~/lib/recovery/expiring-card";
import { getChurnView } from "~/lib/intelligence/trends.server";
import { listCustomerDirectory, listCustomerTiers } from "~/lib/intelligence/directory.server";
import {
  getFailedPaymentDetail,
  getGlobalPaymentStatusCounts,
  listExpiringCardAlerts,
  listFilteredFailedPayments,
  listWinbackSequences,
  type FailedPaymentPageSize,
  type RecoveryStepRow,
} from "~/lib/recovery/queries.server";
import { readVoiceSamples } from "~/lib/recovery/voice-samples";
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

import {
  CONFIRM_ARGUMENT,
  CONFIRM_PROPERTY,
  CONFIRM_RESULT_FIELDS,
  confirmationNeeded,
} from "./confirm.server";
import { maskEmail } from "./redact";
import {
  defineToolRegistry,
  type McpTool,
  type McpToolAnnotations,
  type McpToolContext,
  type McpToolRegistry,
  ToolInputError,
} from "./registry";
import { pageCursor, readPageCursor } from "@dustinedwards/site-runtime/encoding";

// The merchant tools: twelve whole-job tools named foxhound_{action}_{resource}, ten read and two write, each with all
// four behavior hints set honestly. Read and write are never one tool. Design: capsid/research/design-mcp-servers.md
// section 5; foxhound_get_settings gives every writer a reader.
// The account comes from the key and nowhere else: each executor receives the account the bearer token resolved to,
// and no tool takes an account id as an argument. Every id an agent passes is proved to be this account's (rule 12.1):
// the helpers pin the account in their own predicate, so another merchant's id reads as "not found";
// test/mcp-ownership.test.ts plants another merchant's row behind every id-taking argument.
// No money tool exists here and none will: the HUMAN-FOREVER denylist in ./registry.ts refuses one at construction;
// nothing imports `executeMoneyWrite`, `recordOutcome`, a billing writer or a dispute writer.
// Redaction is default-on and not in this file: registering a tool redacts it (./redact.ts). A tool chooses WHICH
// fields to return, never disguises one.

type ToolArgs = Record<string, unknown>;

/** A tool's outputSchema: an object naming its top-level fields, `required` only those always present (a lookup that
 *  may come back empty is not required). Nested shapes are left open; the SDK checks each successful result against it. */
function result(fields: string[], required: string[] = fields) {
  return {
    type: "object" as const,
    properties: Object.fromEntries(fields.map((field) => [field, {}])),
    required,
  };
}

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

//
// One shape everywhere: a list takes an optional `cursor` and answers `has_more` and `next_cursor` (null on the last
// page). The cursor is opaque, names its tool (a cursor from another list is refused with a sentence), and carries a
// position only: the account still comes from the key on every page.

const CURSOR_PROPERTY = {
  type: "string",
  description: "Omit for the first page. To read on, pass next_cursor from the previous answer.",
} as const;

function decodeOffsetCursor(tool: string, args: ToolArgs): number {
  const raw = args["cursor"];
  if (raw === undefined || raw === null || raw === "") return 1;
  const refusal = new ToolInputError(
    `That cursor was not issued by ${tool}. Omit cursor to start from the first page.`,
  );
  const p = typeof raw === "string" ? readPageCursor(tool, raw) : null;
  if (p === null || p < 1) throw refusal;
  return p;
}

function pageInfo(tool: string, page: number, totalPages: number) {
  const hasMore = page < totalPages;
  return { has_more: hasMore, next_cursor: hasMore ? pageCursor(tool, page + 1) : null };
}

function slicePage<T>(tool: string, rows: T[], page: number, pageSize: number) {
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const items = rows.slice((page - 1) * pageSize, page * pageSize);
  return { items, total: rows.length, ...pageInfo(tool, page, totalPages) };
}

/** One billing line as an agent sees it: a PICK, because the enriched line carries the whole dispute row and the admin audit entry (an admin's address). */
function lineItemForAgent(l: EnrichedLineItem) {
  return {
    id: l.lineItem.id,
    type: l.lineItem.type,
    currency: l.lineItem.currency,
    amountCents: l.lineItem.amountCents,
    feeCents: l.lineItem.feeCents,
    description: l.lineItem.description,
    createdAt: l.lineItem.createdAt,
    creditsLineItemId: l.lineItem.creditsLineItemId,
    recovery: l.recoveredPayment
      ? {
          recoveredAt: l.recoveredPayment.recoveredAt,
          amountCents: l.recoveredPayment.amountCents,
          currency: l.recoveredPayment.currency,
          recoveryMethod: l.recoveredPayment.recoveryMethod,
          attributionKind: l.recoveredPayment.attributionKind,
          daysToRecover: l.recoveredPayment.daysToRecover,
          creditedStepType: l.creditedStepType,
        }
      : null,
    dispute: l.dispute
      ? {
          id: l.dispute.id,
          stripeDisputeId: l.dispute.stripeDisputeId,
          amountCents: l.dispute.amountCents,
          currency: l.dispute.currency,
          outcome: l.dispute.outcome,
        }
      : null,
    adjustmentRecordedAt: l.adminAuditEntry?.createdAt ?? null,
  };
}

/** A dispute on the wire is a PICK, not a row: the 60-column `disputes` table holds `customerIp`, `billingAddress`,
 *  model-written `aiResponseText` and `triageReasoning`, and JSON blobs of purchase history and sent mail.
 *  `customerIp` and `billingAddress` are redacted at the boundary too (defense in depth); the projection is the
 *  ONLY cover for the rest, since purchase history and Foxhound's own text are facts about the merchant's
 *  relationship with a customer and are deliberately not redacted. This is an allowlist: a new column reaches an
 *  agent when someone decides it should. `customerEmail` is listed and arrives masked, so a dispute can still be
 *  correlated to a customer seen elsewhere. */
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

/** A recovery step on the wire, a PICK for the same reason: the row carries the email Foxhound wrote (`aiSubject`,
 *  `aiBodyHtml`, `customBody`, greeting the customer by name) and send error text that can carry their address.
 *  Returns what ran, when, what happened and how the customer engaged, never the letter itself. */
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

const PAYMENT_PAGE_SIZES = [10, 25, 50, 100] as const;
const DISPUTE_PAGE_SIZE = 25;
const AUDIT_RUN_PAGE_SIZE = 12;
const RECOVERY_LIST_PAGE_SIZE = 25;
/** The audit-run history window; the helper takes a limit, not an offset, so pages are cut from this many newest runs. */
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
          description:
            "Only payments in this recovery status, for example active, recovered, failed or canceled.",
        },
        decline_category: {
          type: "string",
          description:
            "Only payments with this decline category, for example soft, expired, network or fraud.",
        },
        page_size: {
          type: "integer",
          enum: [...PAYMENT_PAGE_SIZES],
          description: "Rows per page. Defaults to 25.",
        },
        cursor: CURSOR_PROPERTY,
      },
      required: [],
    },
    outputSchema: result(
      ["payments", "total", "has_more", "next_cursor"],
      ["payments", "has_more"],
    ),
    annotations: READ,
    scope: "read",
    execute: async (ctx, args) => {
      const tool = "foxhound_list_payments";
      const page = decodeOffsetCursor(tool, args);
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
      // The helper clamps a page past the end to the last page, right for a screen and wrong for a cursor: past the end is empty.
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
      properties: {
        payment_id: {
          type: "string",
          description: "The failed payment's id, from foxhound_list_payments.",
        },
      },
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
        tier: {
          type: "string",
          description: "Only customers on this plan tier, as listed in tiers.",
        },
        cursor: CURSOR_PROPERTY,
      },
      required: [],
    },
    outputSchema: result(
      ["customers", "total", "total_mrr_cents", "tiers", "has_more", "next_cursor"],
      ["customers", "has_more"],
    ),
    annotations: READ,
    scope: "read",
    execute: async (ctx, args) => {
      const tool = "foxhound_list_customers";
      const page = decodeOffsetCursor(tool, args);
      const [result, tiers] = await Promise.all([
        // No search, on purpose: the directory's search matches customer names, so it would let an agent confirm a guessed
        // name. A customer is found by tier or by paging.
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
        stripe_customer_id: {
          type: "string",
          description: "The Stripe customer id, from foxhound_list_customers.",
        },
      },
      required: ["stripe_customer_id"],
    },
    outputSchema: result(["customer"], []),
    annotations: READ,
    scope: "read",
    execute: async (ctx, args) => {
      const customerId = required(
        args,
        "stripe_customer_id",
        "Take one from foxhound_list_customers.",
      );
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
    title: "Churn, alerts, recommendations and reports",
    description:
      "Read this account's subscription intelligence. view churn (the default): churn bands, the churn chart series, the highest-risk customers, and the metric alerts with their recent firings; alert ids from here are the ones foxhound_manage_alerts takes. view recommendations: customers with a recommended next action, largest MRR first, 50 a page (pass next_cursor back to read on). view reports: the monthly narrative reports, newest first, with Stripe customer ids in place of names. Read only: dismissing or snoozing a recommendation is not offered.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        view: {
          type: "string",
          enum: ["churn", "recommendations", "reports"],
          description: "What to read. Defaults to churn.",
        },
        cursor: CURSOR_PROPERTY,
      },
      required: [],
    },
    outputSchema: result(
      [
        "churn",
        "alerts",
        "alert_history",
        "recommendations",
        "reports",
        "total",
        "has_more",
        "next_cursor",
      ],
      [],
    ),
    annotations: READ,
    scope: "read",
    execute: async (ctx, args) => {
      const tool = "foxhound_get_intelligence";
      const view = stringArg(args, "view") ?? "churn";
      if (view === "recommendations") {
        const page = decodeOffsetCursor(tool, args);
        const { rows, totalCount } = await listActionableRecommendations(
          ctx.db,
          ctx.accountId,
          page,
        );
        const totalPages = Math.max(1, Math.ceil(totalCount / RECOMMENDATIONS_PAGE_SIZE));
        return {
          recommendations: rows.map((r) => ({
            stripeCustomerId: r.stripeCustomerId,
            planName: r.planName,
            mrrContributionCents: r.mrrContributionCents,
            currency: r.currency,
            healthScore: r.healthScore,
            recommendedAction: r.recommendedAction,
          })),
          total: totalCount,
          ...pageInfo(tool, page, totalPages),
        };
      }
      if (view === "reports") {
        const reports = await getReportsArchive(ctx.db, ctx.accountId, { forAgent: true });
        return {
          reports: reports.map((r) => ({
            id: r.id,
            reportMonth: r.reportMonth,
            generatedAt: r.generatedAt,
            narrative: r.narrative,
          })),
        };
      }
      if (view !== "churn") {
        throw new ToolInputError("view must be one of churn, recommendations or reports.");
      }
      const [churn, alerts] = await Promise.all([
        getChurnView(ctx.db, ctx.accountId, ctx.now.getTime()),
        getAlertsView(ctx.db, ctx.accountId),
      ]);
      return { churn, alerts: alerts.alerts, alert_history: alerts.history };
    },
  },
  {
    name: "foxhound_get_recovery",
    title: "Recovery performance, win-back and expiring cards",
    description:
      "Read how recovery is doing. view summary (the default): failed payments active and total, the recovery rate, revenue recovered, the billable subset and the fee that would be owed, per currency. view winback: customers who canceled and Foxhound's win-back sequence for each, newest first, 25 a page. view expiring_cards: cards that are expiring or have expired, soonest first, 25 a page, with whether each has already expired and whether the customer was alerted. Paginated views take next_cursor. Customer emails are masked and no name is returned. Read only: cannot start, pause, resume or cancel a sequence or send an alert; foxhound_list_payments and foxhound_get_payment cover the failed payments themselves.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        view: {
          type: "string",
          enum: ["summary", "winback", "expiring_cards"],
          description: "What to read. Defaults to summary.",
        },
        cursor: CURSOR_PROPERTY,
      },
      required: [],
    },
    outputSchema: result(["stats", "sequences", "cards", "total", "has_more", "next_cursor"], []),
    annotations: READ,
    scope: "read",
    execute: async (ctx, args) => {
      const tool = "foxhound_get_recovery";
      const view = stringArg(args, "view") ?? "summary";
      if (view === "summary") {
        return { stats: await getRecoveryStats(ctx.db, ctx.accountId, ctx.now.getTime()) };
      }
      const page = decodeOffsetCursor(tool, args);
      if (view === "winback") {
        const rows = await listWinbackSequences(ctx.db, ctx.accountId);
        const { items, ...rest } = slicePage(tool, rows, page, RECOVERY_LIST_PAGE_SIZE);
        return {
          sequences: items.map((r) => ({
            id: r.id,
            stripeCustomerId: r.stripeCustomerId,
            customerEmail: r.customerEmail,
            planName: r.planName,
            amountCents: r.amountCents,
            currency: r.currency,
            status: r.status,
            createdAt: r.createdAt,
            resolvedAt: r.resolvedAt,
            reactivatedAt: r.reactivatedAt,
          })),
          ...rest,
        };
      }
      if (view === "expiring_cards") {
        const rows = await listExpiringCardAlerts(ctx.db, ctx.accountId, {
          includeNoPaymentMethod: true,
        });
        const { items, ...rest } = slicePage(tool, rows, page, RECOVERY_LIST_PAGE_SIZE);
        return {
          cards: items.map((r) => ({
            id: r.id,
            stripeCustomerId: r.stripeCustomerId,
            customerEmail: r.customerEmail,
            reason: r.reason,
            cardBrand: r.cardBrand,
            cardLast4: r.cardLast4,
            expiresMonth: r.expiresMonth,
            expiresYear: r.expiresYear,
            expired: isCardExpired(r.expiresYear, r.expiresMonth, ctx.now),
            expiringSoon: isCardExpiringSoon(r.expiresYear, r.expiresMonth, ctx.now),
            alertSentAt: r.alertSentAt,
          })),
          ...rest,
        };
      }
      throw new ToolInputError("view must be one of summary, winback or expiring_cards.");
    },
  },
  {
    name: "foxhound_list_disputes",
    title: "Disputes and auto-submit",
    description:
      "List this account's disputes, newest first, with state, amount, evidence deadline and triage recommendation, together with the dispute settings: whether Disputes is on, whether auto-submit is on, who turned it on and when, and the rule (an unsubmitted dispute is submitted automatically when its deadline is within a day). Paginated, 25 a page: pass next_cursor back to read on. Pass dispute_id for one dispute in full: its evidence fields (names and sizes, not the text), the approval trail that says whether a person or auto-submit approved the submission, the money Stripe withdrew and reinstated, and when auto-submit will act on it. Read only: cannot submit evidence, approve a submission, accept a dispute or turn auto-submit on or off; those stay in the Foxhound app, where the merchant signs in.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        dispute_id: {
          type: "string",
          description: "One dispute's id, from an earlier answer. Omit to list disputes.",
        },
        cursor: CURSOR_PROPERTY,
      },
      required: [],
    },
    outputSchema: result(
      ["disputes", "dispute", "settings", "auto_submit", "total", "has_more", "next_cursor"],
      [],
    ),
    annotations: READ,
    scope: "read",
    execute: async (ctx, args) => {
      const tool = "foxhound_list_disputes";
      const [settings, autoSubmit] = await Promise.all([
        readDisputeSettings(ctx.db, ctx.accountId),
        readDisputeAutoSubmit(ctx.db, ctx.accountId),
      ]);
      const autoSubmitState = {
        enabled: autoSubmit.enabled,
        turned_on_by: maskEmail(autoSubmit.optedInByEmail),
        turned_on_at: autoSubmit.optedInAt,
        submits_hours_before_deadline: DISPUTE_AUTO_SUBMIT_HOURS,
      };
      const disputeId = stringArg(args, "dispute_id");
      if (disputeId !== null) {
        const detail = await getDisputeDetail(ctx.db, ctx.accountId, disputeId);
        if (!detail) {
          throw new ToolInputError(
            `No dispute ${disputeId} on this account. Omit dispute_id to list this account's disputes.`,
          );
        }
        const { dispute, evidence, approval, funds } = detail;
        const deadline = dispute.evidenceDeadline;
        const unsubmitted = dispute.submittedAt === null && approval === null;
        return {
          dispute: {
            ...disputeForAgent(dispute),
            // The evidence is a PICK of its shape: the text can name the customer, so an agent sees which fields are filled and
            // how long, and the merchant reads the words in the app.
            evidence: evidence.map((e) => ({
              field: e.fieldName,
              characters: e.fieldValue.length,
              staged_at: e.createdAt,
            })),
            approval: approval
              ? {
                  approved_at: approval.approvedAt,
                  approved_by: maskEmail(approval.approvedByEmail),
                  automatic: approval.standingOptInAt !== null,
                  standing_opt_in_at: approval.standingOptInAt,
                }
              : null,
            funds,
            auto_submit_due_at:
              autoSubmit.enabled && unsubmitted && deadline
                ? new Date(deadline.getTime() - DISPUTE_AUTO_SUBMIT_HOURS * 3_600_000)
                : null,
          },
          settings,
          auto_submit: autoSubmitState,
        };
      }
      const page = decodeOffsetCursor(tool, args);
      const { rows, total } = await listDisputesPage(
        ctx.db,
        ctx.accountId,
        page,
        DISPUTE_PAGE_SIZE,
      );
      const rest = {
        total,
        ...pageInfo(tool, page, Math.max(1, Math.ceil(total / DISPUTE_PAGE_SIZE))),
      };
      return {
        disputes: rows.map(disputeForAgent),
        settings,
        auto_submit: autoSubmitState,
        ...rest,
      };
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
        run_id: {
          type: "string",
          description: "One audit run's id, from an earlier answer. Omit to list runs.",
        },
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
      const page = decodeOffsetCursor(tool, args);
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
    title: "Foxhound billing and invoices",
    description:
      "Read this account's own Foxhound billing: the attributed-recovery ledger, past invoices and the next billing run's preview. Pass invoice_id (an id from the invoices in an earlier answer) for one invoice in full, with each line item and the evidence behind it. Read only: cannot issue, pay, adjust or void anything.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        invoice_id: {
          type: "string",
          description:
            "One invoice's id, from invoices in an earlier answer. Omit for the summary.",
        },
      },
      required: [],
    },
    outputSchema: result(["ledger", "invoices", "preview", "invoice", "line_items"], []),
    annotations: READ,
    scope: "read",
    execute: async (ctx, args) => {
      const invoiceId = stringArg(args, "invoice_id");
      if (invoiceId !== null) {
        const detail = await getBillingInvoiceDetail(ctx.db, ctx.accountId, invoiceId);
        if (!detail) {
          throw new ToolInputError(
            `No invoice ${invoiceId} on this account. Omit invoice_id to list this account's invoices.`,
          );
        }
        // A PICK, like disputes and steps: the enriched line carries the whole dispute row and the admin audit entry.
        const { invoice } = detail;
        return {
          invoice: {
            id: invoice.id,
            currency: invoice.currency,
            periodStart: invoice.periodStart,
            periodEnd: invoice.periodEnd,
            status: invoice.status,
            totalCents: invoice.totalCents,
            stripeInvoiceUrl: invoice.stripeInvoiceUrl,
            createdAt: invoice.createdAt,
            finalizedAt: invoice.finalizedAt,
          },
          line_items: detail.lineItems.map(lineItemForAgent),
        };
      }
      const [ledger, invoices, preview] = await Promise.all([
        getBillingLedger(ctx.db, ctx.accountId),
        listBillingInvoices(ctx.db, ctx.accountId),
        getBillingPreview(ctx.db, ctx.accountId, ctx.now.getTime()),
      ]);
      // The ledger is a PICK too, for the same reason as the invoice view.
      return {
        ledger: {
          lineItems: ledger.lineItems.map(lineItemForAgent),
          freeRecoveries: ledger.freeRecoveries.map((f) => ({
            recoveredAt: f.recoveredPayment.recoveredAt,
            amountCents: f.recoveredPayment.amountCents,
            currency: f.recoveredPayment.currency,
            recoveryMethod: f.recoveredPayment.recoveryMethod,
            attributionKind: f.recoveredPayment.attributionKind,
            daysToRecover: f.recoveredPayment.daysToRecover,
          })),
        },
        invoices,
        preview,
      };
    },
  },
  // The reader for every setting foxhound_update_settings writes: a writer an agent cannot read first forces it to guess.
  // Each section returns the fields its writer takes, so read-then-write round-trips.
  {
    name: "foxhound_get_settings",
    title: "Read settings",
    description:
      "Read every setting foxhound_update_settings can change: audit window, the two engine toggles, notification email and toggles, the connected Stripe accounts, the primary connection's sender name and brand voice, and the business context the email writer is given. The Slack webhook URL is never returned, only whether one is set.",
    inputSchema: { type: "object", additionalProperties: false, properties: {}, required: [] },
    outputSchema: result(
      [
        "audit",
        "features",
        "notifications",
        "connections",
        "sender",
        "brand_voice",
        "intelligence_context",
      ],
      ["features", "notifications"],
    ),
    annotations: READ,
    scope: "read",
    execute: async (ctx) => {
      const [account, audit, connections, sender, voices, intelligence_context] = await Promise.all(
        [
          getAccount(ctx.db, ctx.accountId),
          readAccountAuditSettings(ctx.db, ctx.accountId),
          listAccountConnections(ctx.db, ctx.accountId),
          getPrimarySenderConnection(ctx.db, ctx.accountId),
          getPrimaryBrandVoices(ctx.db, ctx.accountId),
          getMerchantContext(ctx.db, ctx.accountId),
        ],
      );
      // Voice samples are left out: the merchant's past emails name customers, are one JSON string the field redactor cannot
      // see into, and no writer here takes them back.
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
              // Counts only: the samples name customers, so the text stays in the app.
              sample_count: readVoiceSamples(voices.samples).length,
              sample_characters: readVoiceSamples(voices.samples).map((x) => x.length),
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
          sequenceCompleteNotificationsEnabled:
            account?.sequenceCompleteNotificationsEnabled ?? null,
        },
        connections,
        sender,
        brand_voice,
        intelligence_context,
      };
    },
  },
];

// The two writes. Every write goes through the form's own code path (the same `applyX` the route action calls: same
// bounds, allowlist and refusal string). Every write leaves a trace: a `WriteTrace` with the api key id and tool name goes
// in the SAME batch as the write. One section per call, so each call is one form's batch and all-or-nothing.

/** Turn an apply result into a tool response, or a tool error carrying the form's own refusal string. */
function applied<T>(
  result: { ok: true; fields: string[]; state: T } | { ok: false; error: string },
): { updated: string[]; state: T } {
  if (!result.ok) throw new ToolInputError(result.error);
  return { updated: result.fields, state: result.state };
}

/** Copy only the keys the agent sent, renamed, so an omitted key stays omitted: `{ general: args.general ?? "" }` would
 *  silently and unrecoverably clear the column on every call that left it out. */
function sentOnly(section: ToolArgs, names: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [from, to] of Object.entries(names)) {
    if (section[from] !== undefined) out[to] = section[from];
  }
  return out;
}

function withoutWebhookUrl(result: Parameters<typeof applied<NotificationSettingsState>>[0]) {
  const { updated, state } = applied(result);
  const { slackWebhookUrl, ...rest } = state;
  return { updated, state: { ...rest, slackWebhookConfigured: Boolean(slackWebhookUrl) } };
}

/** Refuse a connection id that is not this account's, in words an agent can act on, before the writer runs. The writers
 *  prove ownership too, but refuse with the settings form's "Connect Stripe before setting a sender name.", which
 *  misleads an agent that sent a bad id. A second check, not the only one. */
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
  // The webhook URL is a credential for the merchant's Slack, so the answer says whether one is set and never echoes it.
  notifications: async (ctx, s) =>
    withoutWebhookUrl(
      await applyNotificationSettings(
        ctx.env,
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
  // This text lands in the system prompt that writes recovery emails. Not sanitized on the way in, as the form does not:
  // `sanitizeCopy` and `passesQualityGate` run on what comes out.
  brand_voice: async (ctx, s) => {
    await requireOwnConnection(ctx, s);
    const done = applied(
      await applyBrandVoice(
        ctx.db,
        ctx.accountId,
        {
          connectionId: s.connection_id,
          ...sentOnly(s, {
            general: "general",
            soft: "soft",
            expired: "expired",
            network: "network",
            fraud: "fraud",
            samples: "samples",
          }),
        },
        ctx.trace,
      ),
    );
    // The samples were written but are not echoed: they name customers, so the answer carries counts only.
    const { samples, ...state } = done.state;
    return {
      ...done,
      state: {
        ...state,
        sample_count: samples.length,
        sample_characters: samples.map((x) => x.length),
      },
    };
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

/** What a settings call would do, in words the merchant can approve. A Slack webhook URL is a credential: named, never shown. */
function describeSettingsChange(name: string, section: ToolArgs): string {
  const shown = Object.entries(section).map(([field, value]) =>
    field === "slack_webhook_url"
      ? `${field}: ${value ? "a new Slack webhook URL" : "cleared"}`
      : `${field}: ${JSON.stringify(value)}`,
  );
  const cleared =
    name === "notifications" && section.slack_webhook_url === undefined
      ? ["slack_webhook_url: cleared"]
      : [];
  return `Overwrite the ${name} settings with ${[...shown, ...cleared].join(", ") || "nothing"}.${
    name === "notifications"
      ? " Every notification field is replaced, and clearing the email turns every notification off."
      : ""
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
            lookback_days: {
              type: "integer",
              description: "30, 60, 90 or 180. Other values clamp.",
            },
            auto_run: { type: "boolean", description: "Send the monthly audit report." },
          },
          required: ["lookback_days", "auto_run"],
        },
        features: {
          type: "object",
          description:
            "Switch the win-back and expiring-card engines on or off (the engines, not the notifications about them).",
          properties: {
            winback_notifications_enabled: { type: "boolean" },
            expiring_card_notifications_enabled: { type: "boolean" },
          },
          required: ["winback_notifications_enabled", "expiring_card_notifications_enabled"],
        },
        notifications: {
          type: "object",
          description:
            "Notification email, Slack webhook and the four notification toggles. Every field is replaced. Clearing the email turns every notification off.",
          properties: {
            notification_email: { type: "string", description: "Empty or omitted clears it." },
            slack_webhook_url: {
              type: "string",
              description:
                "Must be on https://hooks.slack.com/. Empty or omitted clears it; send it again to keep it.",
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
            sender_name: {
              type: "string",
              description: "Up to 80 characters. Empty clears it and mail goes out from Support.",
            },
          },
          required: ["connection_id"],
        },
        brand_voice: {
          type: "object",
          description:
            "The tone Foxhound writes one connection's recovery emails in: free-form guidance for the writer, not a template, and optionally the merchant's own past emails as samples.",
          properties: {
            connection_id: { type: "string", description: "From foxhound_get_settings." },
            general: {
              type: "string",
              description: "The voice for every category with no override.",
            },
            soft: {
              type: "string",
              description: "Soft declines: insufficient funds and the like.",
            },
            expired: { type: "string", description: "Expired card." },
            network: { type: "string", description: "Network and issuer declines." },
            fraud: { type: "string", description: "Suspected fraud." },
            samples: {
              type: "array",
              items: { type: "string" },
              maxItems: 5,
              description:
                "Up to five past emails the merchant wrote themselves, up to 3,000 characters each, that the writer matches in length, greeting and sign-off. Replaces the stored samples; an empty list clears them. The merchant supplies the text. They are never read back: foxhound_get_settings reports only how many there are and how long.",
            },
          },
          required: ["connection_id"],
        },
        intelligence_context: {
          type: "object",
          description: "What kind of business this is. The recovery-email writer is given these.",
          properties: {
            merchant_industry: { type: "string", description: 'For example "B2B SaaS".' },
            primary_customer_type: {
              type: "string",
              description: 'For example "small businesses".',
            },
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
    // Destructive because a value is overwritten and clearing the notification email silences every notification, so it is
    // confirmed first (./confirm.server.ts). Idempotent: the same call twice leaves the same settings.
    outputSchema: result(["section", "updated", "state", ...CONFIRM_RESULT_FIELDS, "note"], []),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
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
      const pending = await confirmationNeeded(
        ctx,
        "foxhound_update_settings",
        args,
        describeSettingsChange(name, section as ToolArgs),
      );
      if (pending) return pending;
      return {
        section: name,
        ...((await SETTINGS_SECTIONS[name](ctx, section as ToolArgs)) as object),
      };
    },
  },
  {
    name: "foxhound_manage_alerts",
    title: "Manage alerts",
    // Deletion is named because it takes the alert's firing history with it, unrecoverably.
    description:
      "Create, enable, disable or delete one of this account's metric alerts. action create takes metric, direction and threshold (dollars for amount metrics, a percent for the recovery rate, a plain count otherwise), an optional label and an optional channel (email, the default, or slack); enable, disable and delete take alert_id from foxhound_get_intelligence, which must belong to this account. Deleting also removes that alert's recorded breaches. A breach is recorded in the app and sent to the alert's channel at most once a day. delete is confirmed first: the first call deletes nothing and answers what it would delete and a confirm code; show that to the merchant and call again with the same arguments and confirm only if they say yes.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: { type: "string", enum: [...ALERT_ACTIONS], description: "What to do." },
        alert_id: {
          type: "string",
          description: "For enable, disable and delete: from foxhound_get_intelligence.",
        },
        metric: {
          type: "string",
          description: "For create: one of the metrics foxhound_get_intelligence reports.",
        },
        direction: {
          type: "string",
          description: "For create: whether the metric rising or dropping fires.",
        },
        threshold: {
          type: ["number", "string"],
          description: "For create: dollars for amount metrics, a plain count otherwise.",
        },
        label: { type: "string", description: "For create: an optional name for the alert." },
        channel: {
          type: "string",
          enum: ["email", "slack"],
          description: "For create: where a breach is sent. Defaults to email.",
        },
        [CONFIRM_ARGUMENT]: {
          ...CONFIRM_PROPERTY,
          description: `For delete. ${CONFIRM_PROPERTY.description}`,
        },
      },
      required: ["action"],
    },
    // Destructive because delete is, so confirmed first (./confirm.server.ts); not idempotent because create makes a new alert each time.
    outputSchema: result(["action", "updated", "state", ...CONFIRM_RESULT_FIELDS, "note"], []),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    scope: "write",
    execute: async (ctx, args) => {
      const action = args["action"];
      if (action === "create") {
        if (args["alert_id"] !== undefined) {
          throw new ToolInputError(
            "create makes a new alert and takes no alert_id. Drop alert_id, or use enable, disable or delete.",
          );
        }
        return {
          action,
          ...applied(
            await applyAlertCreate(
              ctx.db,
              ctx.accountId,
              {
                metric: args.metric,
                direction: args.direction,
                threshold: args.threshold,
                label: args.label,
                channel: args.channel,
              },
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
              {
                alertId: args.alert_id,
                enabled: action === "enable",
                deleted: action === "delete",
              },
              ctx.trace,
            ),
          ),
        };
      }
      throw new ToolInputError(`action must be one of ${ALERT_ACTIONS.join(", ")}.`);
    },
  },
];

/** The live registry. `defineToolRegistry` runs the HUMAN-FOREVER denylist and name rule over every name at module load
 *  and wraps every executor in the redactor. */
export const MERCHANT_TOOLS: McpToolRegistry = defineToolRegistry([...READ_TOOLS, ...WRITE_TOOLS]);

export const MERCHANT_TOOL_NAMES = [...READ_TOOLS, ...WRITE_TOOLS].map((t) => t.name);
export const MERCHANT_WRITE_TOOL_NAMES = WRITE_TOOLS.map((t) => t.name);
