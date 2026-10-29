import { isUniqueConstraintError } from "~/lib/money/serializer";
import type { DisputeState } from "~/lib/constants";
import type { DisputeSubmissionResult } from "~/lib/disputes/submission";

// The dispute approve-and-submit flow (Phase 5 slice 5c, DESIGN.md flagship
// surface 2; hardened per the dispute-intake review MEDIUM). Splitting the old
// single "submit-then-write-approval" step into TWO phases bracketing the
// Stripe call closes the window where Stripe could hold a submission with no
// durable record on our side:
//
//   Phase A (buildPendingApprovalBatch, BEFORE Stripe): write the
//     dispute_approvals row. Its presence is the durable proof the merchant
//     approved and a submission was attempted. The unique index on
//     dispute_approvals.dispute_id serializes concurrent approvals.
//   Phase C (buildSubmissionConfirmationBatch, AFTER Stripe accepts): advance
//     the dispute to `submitted` and set disputes.submitted_at. submitted_at is
//     the marker billing keys off (app/db/billable.ts getBillableDisputes), so
//     it is set ONLY once Stripe genuinely accepted the evidence. A win
//     Foxhound never submitted has no submitted_at and is never billed.
//
// This file is deliberately drizzle-orm/~db-free (perf-audit fix,
// foxhound-audit-perf.md M-1): canApprove is a plain function the disputes
// detail PAGE COMPONENT calls directly, so this file is reachable from the
// client bundle. buildPendingApprovalBatch/buildSubmissionConfirmationBatch
// (the actual db.insert()/db.update() query builders) live in
// approval.server.ts instead, imported only by ~/lib/disputes/queries.server.
// Keeping so much as one drizzle-orm import in THIS file was enough to pull
// the ORM and the disputes/dispute_approvals table objects into the client
// chunk even when nothing in the client-reachable code path actually used
// them (verified: moving the two db.batch() calls into named .server.ts
// functions alone did not fix it, only removing every table/drizzle-orm
// import from this file did).

/** A dispute can be approved and submitted from any pre-submission state. Once
 *  submitted or resolved, this is never true again (no re-approval, no reopen
 *  via this path). Exported so approval.server.ts's SQL builders can exclude
 *  the same states without redefining the list. */
export const SUBMITTED_OR_RESOLVED: readonly DisputeState[] = [
  "submitted",
  "resolved_won",
  "resolved_lost",
  "inquiry_closed",
];

export function canApprove(state: DisputeState): boolean {
  return !(SUBMITTED_OR_RESOLVED as readonly string[]).includes(state);
}

/** SHA-256 hex of the evidence fields at the moment of approval, canonicalized
 *  by field name so the hash does not depend on read/render order. Proves
 *  exactly which version of the evidence was approved. */
export async function hashEvidence(fields: { fieldName: string; fieldValue: string }[]): Promise<string> {
  const canonical = [...fields]
    .sort((a, b) => a.fieldName.localeCompare(b.fieldName))
    .map((f) => `${f.fieldName}=${f.fieldValue}`)
    .join("\n");
  const bytes = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Maps a failed buildApprovalBatch write to the clean user-facing message the
 * sequential canApprove pre-check already uses, or null if the caller should
 * rethrow (Phase 5 review MEDIUM fix, 2026-07-19). The structural guarantee
 * (dispute_approvals unique per dispute_id) already makes a double-submit
 * impossible; without this, the LOSING request of a concurrent race (both
 * requests pass the pre-check on a stale read, the second's insert then
 * fails the unique constraint) surfaced as an unhandled 500 instead of the
 * same "already submitted" message.
 */
export function approvalRaceErrorMessage(err: unknown): string | null {
  return isUniqueConstraintError(err) ? "This dispute has already been submitted." : null;
}

// ============================================================================
// Approve -> submit orchestration (PRICING.md hard rule: no evidence is ever
// submitted to Stripe without an explicit merchant approval record; and,
// symmetrically, no submission ever happens without a durable record on our
// side, dispute-intake review MEDIUM)
// ============================================================================

/** Outcome of the pre-submit durable write (Phase A):
 *  - `created`: a fresh pending approval row was written.
 *  - `resume`: a pending (unconfirmed) approval row from a prior attempt already
 *     exists; proceed and re-submit rather than dead-end.
 *  - `already_submitted`: a CONFIRMED submission already exists; reject. */
export type PendingApprovalOutcome = "created" | "resume" | "already_submitted";

export interface ApproveAndSubmitDeps {
  /** Phase A: write the durable pending-approval record BEFORE the Stripe call
   *  (buildPendingApprovalBatch), reporting whether it was created, is being
   *  resumed, or is already a confirmed submission. */
  writePendingApproval: () => Promise<PendingApprovalOutcome>;
  /** Phase B: submit the merchant-approved evidence to Stripe. */
  submit: () => Promise<DisputeSubmissionResult>;
  /** Phase C: confirm the submission (buildSubmissionConfirmationBatch: advance
   *  state to submitted + set submitted_at). Reached ONLY after Stripe accepted.
   *  A throw here is a post-submit DB failure and propagates to the caller. */
  confirmSubmission: () => Promise<void>;
}

export type ApproveAndSubmitResult = { status: "submitted" } | { status: "error"; message: string };

/**
 * Orchestrates approve-and-submit as three ordered phases so the durable
 * approval record and the actual Stripe submission can never diverge:
 *
 *   A (writePendingApproval) BEFORE B (submit) BEFORE C (confirmSubmission).
 *
 * The record is written before Stripe, so Stripe can never hold a submission
 * with no record on our side. The `submitted` marker (billing's signal) is
 * written only in Phase C, after Stripe accepts, so billing counts a dispute as
 * Foxhound-submitted iff Stripe genuinely took the evidence. A failed Stripe
 * call short-circuits before Phase C (retriable; the pending record resumes).
 * Pure over injected deps, so the ordering invariant is directly unit-tested.
 */
export async function approveAndSubmit(deps: ApproveAndSubmitDeps): Promise<ApproveAndSubmitResult> {
  const pending = await deps.writePendingApproval();
  if (pending === "already_submitted") {
    return { status: "error", message: "This dispute has already been submitted." };
  }
  const submission = await deps.submit();
  if (!submission.ok) {
    return { status: "error", message: `Stripe did not accept the submission: ${submission.error}` };
  }
  await deps.confirmSubmission();
  return { status: "submitted" };
}
