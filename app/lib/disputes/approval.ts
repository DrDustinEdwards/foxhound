import { sha256Hex } from "@dustinedwards/site-runtime/encoding";
import type { DisputeState } from "~/lib/constants";
import type { DisputeSubmissionResult } from "~/lib/disputes/submission";

// The dispute approve-and-submit flow.
//
//   Phase A (buildPendingApprovalBatch, BEFORE Stripe): write the
//     dispute_approvals row. Its presence is the durable proof the merchant
//     approved and a submission was attempted. The unique index on
//     dispute_approvals.dispute_id lets one request insert; a request that
//     finds the row already there resumes, and reads Stripe before submitting
//     (see ApproveAndSubmitDeps.submittedAtStripe).
//   Phase C (buildSubmissionConfirmationBatch, AFTER Stripe accepts): advance
//     the dispute to `submitted` and set disputes.submitted_at. submitted_at is
//     the marker billing keys off (app/db/billable.ts getBillableDisputes), so
//     it is set ONLY once Stripe genuinely accepted the evidence. A win
//     Foxhound never submitted has no submitted_at and is never billed.

/**
 * A dispute can be approved and submitted from any pre-submission state. Once
 * submitted or resolved, this is never true again (no re-approval, no reopen
 * via this path). Exported so approval.server.ts's SQL builders can exclude the
 * same states without redefining the list.
 */
export const SUBMITTED_OR_RESOLVED: readonly DisputeState[] = [
  "submitted",
  "resolved_won",
  "resolved_lost",
  "inquiry_closed",
];

export function canApprove(state: DisputeState): boolean {
  return !(SUBMITTED_OR_RESOLVED as readonly string[]).includes(state);
}

/**
 * SHA-256 hex of the evidence fields at the moment of approval, canonicalized
 * by field name so the hash does not depend on read/render order. Proves
 * exactly which version of the evidence was approved.
 *
 * The order is by code unit, not localeCompare, so the same fields hash the
 * same on every runtime and locale; the canonical text is JSON of [name, value]
 * pairs, so a value holding "=" or a newline cannot make two different field
 * sets read as one.
 */
export async function hashEvidence(
  fields: { fieldName: string; fieldValue: string }[],
): Promise<string> {
  const pairs = fields
    .map((f) => [f.fieldName, f.fieldValue] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return sha256Hex(JSON.stringify(pairs));
}

// Approve -> submit orchestration

/**
 * Outcome of the pre-submit durable write (Phase A):
 *  - `created`: a fresh pending approval row was written.
 *  - `resume`: a pending (unconfirmed) approval row already exists, from a failed
 *     attempt or a concurrent request; Stripe is read before submitting again.
 *  - `already_submitted`: a CONFIRMED submission already exists; reject.
 */
export type PendingApprovalOutcome = "created" | "resume" | "already_submitted";

export interface ApproveAndSubmitDeps {
  /**
   * Phase A: write the durable pending-approval record BEFORE the Stripe call
   * (buildPendingApprovalBatch), reporting whether it was created, is being
   * resumed, or is already a confirmed submission.
   */
  writePendingApproval: () => Promise<PendingApprovalOutcome>;
  /**
   * Whether Stripe already holds a submission for this dispute. Read only on `resume`: a prior run or a
   * concurrent request may have submitted already, and a second `submit: true` is refused by Stripe.
   */
  submittedAtStripe: () => Promise<boolean>;
  /** Phase B: submit the merchant-approved evidence to Stripe. */
  submit: () => Promise<DisputeSubmissionResult>;
  /**
   * Phase C: confirm the submission (buildSubmissionConfirmationBatch: advance
   * state to submitted + set submitted_at). Reached ONLY after Stripe accepted.
   * A throw here is a post-submit DB failure and propagates to the caller.
   */
  confirmSubmission: () => Promise<void>;
}

export type ApproveAndSubmitResult = { status: "submitted" } | { status: "error"; message: string };

/**
 * Orchestrates approve-and-submit as three ordered phases so the durable
 * approval record and the actual Stripe submission can never diverge:
 *
 * The record is written before Stripe, so Stripe can never hold a submission
 * with no record on our side. The `submitted` marker (billing's signal) is
 * written only in Phase C, after Stripe accepts, so billing counts a dispute as
 * Foxhound-submitted iff Stripe genuinely took the evidence.
 */
export async function approveAndSubmit(
  deps: ApproveAndSubmitDeps,
): Promise<ApproveAndSubmitResult> {
  const pending = await deps.writePendingApproval();
  if (pending === "already_submitted") {
    return { status: "error", message: "This dispute has already been submitted." };
  }
  if (pending === "created" || !(await deps.submittedAtStripe())) {
    const submission = await deps.submit();
    if (!submission.ok) {
      return {
        status: "error",
        message: `Stripe did not accept the submission: ${submission.error}`,
      };
    }
  }
  await deps.confirmSubmission();
  return { status: "submitted" };
}

/**
 * How long before its evidence deadline an unsubmitted dispute is submitted
 * automatically, for an account that turned auto-submit on. Declared here, with
 * the approval rules, so the cron that acts on it and the agent read that
 * reports it cannot disagree.
 */
export const DISPUTE_AUTO_SUBMIT_HOURS = 24;
