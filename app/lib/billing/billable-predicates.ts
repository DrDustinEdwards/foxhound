import { BILLABLE_ATTRIBUTION_KINDS, RECOVERY_MATURITY_MS } from "~/lib/constants";

// Pure row-level billable predicates, factored out so app/db/billable.ts's SQL
// and any in-memory caller (currently only app/lib/demo/seed.ts) can never
// diverge on what counts as billable. Both sources draw the attribution
// allow-list from the SAME constant (BILLABLE_ATTRIBUTION_KINDS), so a new
// attribution kind added to the schema cannot silently become billable in one
// place and not the other. This module intentionally does NOT touch
// app/db/billable.ts's query shape, joins, or account-eligibility gate: the
// demo account is excluded from those queries by design (billing_exempt +
// processing_paused + the demo_ id prefix), so the seeder cannot call
// getBillableRecoveries/getBillableDisputes directly. It calls these
// equivalent pure predicates on its own in-memory rows instead.

export interface BillableRecoveryRow {
  // `undefined` (a Drizzle insert row that never set the column) is treated the
  // same as an unrecognized kind below: fail closed, never billable.
  attributionKind?: string;
  recoveredAt: Date;
  refundedAt?: Date | null;
  disputedAt?: Date | null;
  deletedAt?: Date | null;
}

/**
 * Mirrors app/db/billable.ts's billableRecoveryRowConditions: attributed to a
 * Foxhound action (the allow-list, not a deny-list: a kind absent from
 * BILLABLE_ATTRIBUTION_KINDS is never billable, fail-closed), matured past the
 * 30-day window, and not refunded/disputed/soft-deleted. `== null` deliberately
 * treats both null and undefined as "not set" (Drizzle insert rows may omit an
 * unset nullable column entirely; the DB stores NULL either way).
 */
export function isBillableRecoveryRow(row: BillableRecoveryRow, asOfMs: number): boolean {
  const maturityCutoffMs = asOfMs - RECOVERY_MATURITY_MS;
  return (
    row.attributionKind !== undefined &&
    (BILLABLE_ATTRIBUTION_KINDS as readonly string[]).includes(row.attributionKind) &&
    row.recoveredAt.getTime() <= maturityCutoffMs &&
    row.refundedAt == null &&
    row.disputedAt == null &&
    row.deletedAt == null
  );
}

export interface BillableDisputeRow {
  state?: string;
  submittedAt?: Date | null;
  resolvedAt?: Date | null;
  resolvedFeeCents?: number | null;
}

/**
 * Mirrors app/db/billable.ts's billableDisputeRowConditions PLUS the
 * dispute_approvals inner join getBillableDisputes adds around it: won,
 * resolved by `asOfMs`, AND Foxhound actually submitted it (submitted_at set
 * AND an approval row exists), AND its fee is stored (an unpriced win waits).
 * `hasApproval` stands in for that join since a caller working from in-memory
 * rows has no join to perform; pass whether a dispute_approvals row exists for
 * this dispute id.
 */
export function isBillableDisputeRow(dispute: BillableDisputeRow, hasApproval: boolean, asOfMs: number): boolean {
  return (
    dispute.state === "resolved_won" &&
    dispute.submittedAt != null &&
    hasApproval &&
    dispute.resolvedAt != null &&
    dispute.resolvedAt.getTime() <= asOfMs &&
    dispute.resolvedFeeCents != null
  );
}
