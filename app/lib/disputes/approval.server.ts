import { and, eq, isNull, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";

import type { Db } from "~/db";
import { disputeApprovals, disputes } from "~/db";
import { SUBMITTED_OR_RESOLVED } from "~/lib/disputes/approval";

// The db.insert()/db.update() builders for the approve-and-submit flow (phase ordering: ~/lib/disputes/approval.ts). A .server.ts sibling so drizzle-orm and the dispute tables never share a module with
// canApproveDispute, which the detail page calls directly and so must stay client-reachable.
//
// Not a MoneyWriteBatch (app/db/money-write.ts): that name is reserved for batches routed through the per-account money-write DO. This one deliberately is not (see approval.ts).
type OperationalBatch = [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]];

export interface PendingApprovalInput {
  disputeId: string;
  accountId: string;
  approvedByUserId: string | null;
  approvedByEmail: string;
  evidenceVersionHash: string;
  approvedAt: Date;
  /**
   * When the approver turned auto-submit on, for an approval the auto-submit
   * job writes from that standing opt-in; null for the merchant's own click.
   */
  standingOptInAt: Date | null;
}

/**
 * Phase A (before the Stripe submission): insert the dispute_approvals row, the
 * durable record that the merchant approved and a submission is being
 * attempted. The unique index on dispute_approvals.dispute_id makes a
 * concurrent second attempt fail this insert (caught by the caller,
 * isUniqueConstraintError).
 */
export function buildPendingApprovalBatch(db: Db, input: PendingApprovalInput): OperationalBatch {
  return [
    db.insert(disputeApprovals).values({
      id: crypto.randomUUID(),
      disputeId: input.disputeId,
      accountId: input.accountId,
      approvedByUserId: input.approvedByUserId,
      approvedByEmail: input.approvedByEmail,
      evidenceVersionHash: input.evidenceVersionHash,
      approvedAt: input.approvedAt,
      standingOptInAt: input.standingOptInAt,
    }),
  ];
}

export interface SubmissionConfirmationInput {
  disputeId: string;
  accountId: string;
  submittedBy: string;
  submittedAt: Date;
}

/**
 * Phase C (after Stripe accepts): advance the dispute to `submitted` and set
 * submitted_at + submitted_by. submitted_at is the marker billing keys off, so
 * writing it here, and only here, is what guarantees a dispute is billed only
 * if Stripe genuinely accepted the evidence. Conditional on the dispute not
 * already being submitted or resolved (idempotent under a duplicate confirm and
 * safe if the dispute resolved in the sub-second gap after the Stripe call).
 */
export function buildSubmissionConfirmationBatch(
  db: Db,
  input: SubmissionConfirmationInput,
): OperationalBatch {
  const settled = sql.join(
    SUBMITTED_OR_RESOLVED.map((state) => sql`${state}`),
    sql`, `,
  );
  return [
    db
      .update(disputes)
      .set({
        // A dispute that already resolved (its closed event can beat this
        // write) keeps its state; it still gets the submitted marker, which is
        // the only thing billing reads to know Foxhound filed it.
        state: sql`case when ${disputes.state} in (${settled}) then ${disputes.state} else 'submitted' end`,
        submittedAt: input.submittedAt,
        submittedBy: input.submittedBy,
      })
      .where(
        and(
          eq(disputes.id, input.disputeId),
          eq(disputes.accountId, input.accountId),
          isNull(disputes.submittedAt),
        ),
      ),
  ];
}
