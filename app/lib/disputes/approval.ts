import { and, eq, notInArray } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";

import type { Db } from "~/db";
import { disputeApprovals, disputes } from "~/db";
import type { DisputeState } from "~/lib/constants";
import { isUniqueConstraintError } from "~/lib/money/serializer";

// Not a MoneyWriteBatch (app/db/money-write.ts): that type name is reserved for
// batches routed through the per-account money-write DO. This one deliberately
// is not (see the module comment below), so it gets its own plain alias.
type OperationalBatch = [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]];

// The dispute approval + submission write (Phase 5 slice 5c, DESIGN.md flagship
// surface 2). This is a single explicit action: it writes the approval row and
// advances the dispute straight to `submitted` in one atomic batch, so the
// schema's real guarantee, "no submission without an approval row", holds by
// construction rather than by app-level discipline. This is a PLAIN operational
// batch (not the money-write DO): approving a dispute does not itself gate
// billing, it only makes `resolved_fee_cents` reachable later at resolution
// (Scope B, which IS driven by a webhook claim and rides the DO). Mirrors the
// recovery_steps precedent (gotcha #25): non-money state advances use a plain
// db.batch(), not the DO.

/** A dispute can be approved and submitted from any pre-submission state. Once
 *  submitted or resolved, this is never true again (no re-approval, no reopen
 *  via this path). */
const SUBMITTED_OR_RESOLVED: readonly DisputeState[] = ["submitted", "resolved_won", "resolved_lost"];

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

export interface ApprovalBatchInput {
  disputeId: string;
  accountId: string;
  approvedByUserId: string | null;
  approvedByEmail: string;
  evidenceVersionHash: string;
  approvedAt: Date;
}

/**
 * The atomic approval batch: advance the dispute to `submitted` (conditional on
 * it not already being submitted or resolved, so a race resolves to exactly one
 * winner) + insert the dispute_approvals row. The unique index on
 * dispute_approvals.dispute_id is the structural backstop: a concurrent second
 * attempt fails that insert and the whole batch rolls back, so a double-submit
 * can never leave two approval rows or a state advance without one.
 */
export function buildApprovalBatch(db: Db, input: ApprovalBatchInput): OperationalBatch {
  return [
    db
      .update(disputes)
      .set({
        state: "submitted",
        submittedAt: input.approvedAt,
        submittedBy: input.approvedByEmail,
      })
      .where(
        and(
          eq(disputes.id, input.disputeId),
          eq(disputes.accountId, input.accountId),
          notInArray(disputes.state, SUBMITTED_OR_RESOLVED as string[]),
        ),
      ),
    db.insert(disputeApprovals).values({
      id: crypto.randomUUID(),
      disputeId: input.disputeId,
      accountId: input.accountId,
      approvedByUserId: input.approvedByUserId,
      approvedByEmail: input.approvedByEmail,
      evidenceVersionHash: input.evidenceVersionHash,
      approvedAt: input.approvedAt,
    }),
  ];
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
