import { and, eq } from "drizzle-orm";

import type { Db } from "~/db";
import { disputeApprovals, disputeEvidence, disputes } from "~/db";

// Disputes read models + the plain (non-money) evidence-edit write (Phase 5
// slice 5c). Every query is account-scoped. Approval + submission itself lives
// in app/lib/disputes/approval.ts (approveAndSubmit); this file is reads plus
// the one edit-affordance write that precedes it.

export type DisputeRow = typeof disputes.$inferSelect;
export type DisputeEvidenceRow = typeof disputeEvidence.$inferSelect;
export type DisputeApprovalRow = typeof disputeApprovals.$inferSelect;

/** Every dispute for the account, newest first. */
export async function listDisputes(db: Db, accountId: string): Promise<DisputeRow[]> {
  const rows = await db.select().from(disputes).where(eq(disputes.accountId, accountId));
  return [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

export interface DisputeDetail {
  dispute: DisputeRow;
  evidence: DisputeEvidenceRow[];
  approval: DisputeApprovalRow | null;
}

/** The full review-and-sign view for one dispute, scoped to the account. Null
 *  when the id does not exist or belongs to another account (the route 404s). */
export async function getDisputeDetail(
  db: Db,
  accountId: string,
  disputeId: string,
): Promise<DisputeDetail | null> {
  const rows = await db
    .select()
    .from(disputes)
    .where(and(eq(disputes.id, disputeId), eq(disputes.accountId, accountId)))
    .limit(1);
  const dispute = rows[0];
  if (!dispute) return null;

  const [evidence, approvals] = await Promise.all([
    db
      .select()
      .from(disputeEvidence)
      .where(and(eq(disputeEvidence.disputeId, disputeId), eq(disputeEvidence.accountId, accountId))),
    db
      .select()
      .from(disputeApprovals)
      .where(and(eq(disputeApprovals.disputeId, disputeId), eq(disputeApprovals.accountId, accountId))),
  ]);

  return { dispute, evidence, approval: approvals[0] ?? null };
}

/**
 * Save edits to the evidence draft (the "edit affordance"). A plain atomic
 * batch, not a money write, the same way recovery_steps edits are operational
 * (gotcha #25): editing evidence text does not itself gate billing, only
 * approval + submission (approval.ts) and resolution (webhooks/batches.ts) do.
 * Only touches rows that belong to this dispute and account.
 */
export async function saveDisputeEvidence(
  db: Db,
  accountId: string,
  disputeId: string,
  edits: { id: string; fieldValue: string }[],
): Promise<void> {
  if (edits.length === 0) return;
  const statements = edits.map((edit) =>
    db
      .update(disputeEvidence)
      .set({ fieldValue: edit.fieldValue })
      .where(
        and(
          eq(disputeEvidence.id, edit.id),
          eq(disputeEvidence.disputeId, disputeId),
          eq(disputeEvidence.accountId, accountId),
        ),
      ),
  );
  // db.batch() requires a non-empty tuple type; the leading fixed element (the
  // length check above guarantees it exists) narrows the array literal to one.
  const [first, ...rest] = statements;
  await db.batch([first, ...rest]);
}
