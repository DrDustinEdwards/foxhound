import { getRecoveryStats } from "~/lib/dashboard/stats.server";
import { isCardExpired, isCardExpiringSoon } from "~/lib/recovery/expiring-card";
import {
  getFailedPaymentDetail,
  listFilteredFailedPayments,
  type FailedPaymentPageSize,
  type RecoveryStepRow,
} from "~/lib/recovery/queries.server";
import { listExpiringCardAlerts, listWinbackSequences } from "~/lib/recovery/step-queries.server";

import { type McpTool, ToolInputError } from "./registry";
import {
  type ToolArgs,
  result,
  READ,
  stringArg,
  required,
  CURSOR_PROPERTY,
  decodeOffsetCursor,
  pageInfo,
  slicePage,
} from "./tool-input";

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

const RECOVERY_LIST_PAGE_SIZE = 25;
const PAYMENT_PAGE_SIZES = [10, 25, 50, 100] as const;
function paymentPageSize(args: ToolArgs): FailedPaymentPageSize {
  const raw = args["page_size"];
  if (raw === undefined) return 25;
  if (typeof raw === "number" && (PAYMENT_PAGE_SIZES as readonly number[]).includes(raw)) {
    return raw as FailedPaymentPageSize;
  }
  throw new ToolInputError(`page_size must be one of ${PAYMENT_PAGE_SIZES.join(", ")}.`);
}

export const LIST_PAYMENTS_TOOL: McpTool = {
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
  outputSchema: result(["payments", "total", "has_more", "next_cursor"], ["payments", "has_more"]),
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
};

export const GET_PAYMENT_TOOL: McpTool = {
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
};

export const GET_RECOVERY_TOOL: McpTool = {
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
};
