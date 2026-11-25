import {
  getDisputeDetail,
  listDisputesPage,
  readDisputeAutoSubmit,
  readDisputeSettings,
  type DisputeRow,
} from "~/lib/disputes/queries.server";
import { DISPUTE_AUTO_SUBMIT_HOURS } from "~/lib/disputes/approval";

import { maskEmail } from "./redact";
import { type McpTool, ToolInputError } from "./registry";
import {
  result,
  READ,
  stringArg,
  CURSOR_PROPERTY,
  decodeOffsetCursor,
  pageInfo,
} from "./tool-input";

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

const DISPUTE_PAGE_SIZE = 25;

export const LIST_DISPUTES_TOOL: McpTool = {
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
    const { rows, total } = await listDisputesPage(ctx.db, ctx.accountId, page, DISPUTE_PAGE_SIZE);
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
};
