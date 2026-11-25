import { getBillingPreview } from "~/lib/billing/preview.server";
import type { EnrichedLineItem } from "~/lib/billing/queries.server";
import {
  getBillingInvoiceDetail,
  getBillingLedger,
  listBillingInvoices,
} from "~/lib/billing/queries.server";

import { type McpTool, ToolInputError } from "./registry";
import { result, READ, stringArg } from "./tool-input";

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

export const GET_BILLING_TOOL: McpTool = {
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
        description: "One invoice's id, from invoices in an earlier answer. Omit for the summary.",
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
};
