import { and, asc, eq, inArray } from "drizzle-orm";

import type { Db } from "~/db";
import {
  accountSubscriptions,
  adminAuditLog,
  billingInvoices,
  billingLineItems,
  disputes,
  recoveredPayments,
  recoverySteps,
} from "~/db";

// Billing evidence ledger read models (Phase 5 slice 5d, DESIGN.md flagship
// surface 1). Every query is account-scoped and strictly read-only: nothing
// here recomputes a fee or a billable decision, both already live in the
// stored billing_line_items rows (produced by app/lib/billing/run.ts, which is
// itself a read consumer of app/db/billable.ts). This is why the ledger can
// never contradict billable.ts: it renders exactly what billing already wrote.

export type BillingInvoiceRow = typeof billingInvoices.$inferSelect;
type BillingLineItemRow = typeof billingLineItems.$inferSelect;
type RecoveredPaymentRow = typeof recoveredPayments.$inferSelect;

export interface EnrichedLineItem {
  lineItem: BillingLineItemRow;
  recoveredPayment: RecoveredPaymentRow | null;
  /** The recovery_steps.step_type that earned the recovery, if attributed to one. */
  creditedStepType: string | null;
  dispute: (typeof disputes.$inferSelect) | null;
  adminAuditEntry: (typeof adminAuditLog.$inferSelect) | null;
}

/** Batches the evidence lookups for a set of line items: one query per evidence
 *  table (recovered_payments / disputes / admin_audit_log / recovery_steps),
 *  not one per row. */
async function enrichLineItems(db: Db, lineItems: BillingLineItemRow[]): Promise<EnrichedLineItem[]> {
  const recoveredPaymentIds = lineItems
    .map((l) => l.recoveredPaymentId)
    .filter((v): v is string => v != null);
  const disputeIds = lineItems.map((l) => l.disputeId).filter((v): v is string => v != null);
  const auditIds = lineItems.map((l) => l.adminAuditLogId).filter((v): v is string => v != null);

  const [recoveredRows, disputeRows, auditRows] = await Promise.all([
    recoveredPaymentIds.length
      ? db.select().from(recoveredPayments).where(inArray(recoveredPayments.id, recoveredPaymentIds))
      : Promise.resolve([]),
    disputeIds.length ? db.select().from(disputes).where(inArray(disputes.id, disputeIds)) : Promise.resolve([]),
    auditIds.length
      ? db.select().from(adminAuditLog).where(inArray(adminAuditLog.id, auditIds))
      : Promise.resolve([]),
  ]);

  const stepIds = recoveredRows.map((r) => r.recoveredByStepId).filter((v): v is string => v != null);
  const stepRows = stepIds.length
    ? await db
        .select({ id: recoverySteps.id, stepType: recoverySteps.stepType })
        .from(recoverySteps)
        .where(inArray(recoverySteps.id, stepIds))
    : [];

  const recoveredById = new Map(recoveredRows.map((r) => [r.id, r]));
  const disputeById = new Map(disputeRows.map((d) => [d.id, d]));
  const auditById = new Map(auditRows.map((a) => [a.id, a]));
  const stepTypeById = new Map(stepRows.map((s) => [s.id, s.stepType]));

  return lineItems.map((lineItem) => {
    const recoveredPayment = lineItem.recoveredPaymentId
      ? (recoveredById.get(lineItem.recoveredPaymentId) ?? null)
      : null;
    return {
      lineItem,
      recoveredPayment,
      creditedStepType:
        recoveredPayment?.recoveredByStepId != null
          ? (stepTypeById.get(recoveredPayment.recoveredByStepId) ?? null)
          : null,
      dispute: lineItem.disputeId ? (disputeById.get(lineItem.disputeId) ?? null) : null,
      adminAuditEntry: lineItem.adminAuditLogId ? (auditById.get(lineItem.adminAuditLogId) ?? null) : null,
    };
  });
}

export interface FreeLedgerEntry {
  recoveredPayment: RecoveredPaymentRow;
}

export interface BillingLedger {
  /** Every billed fee, newest first, with its evidence. */
  lineItems: EnrichedLineItem[];
  /** Every stripe_baseline recovery, newest first, marked FREE. Never billed by
   *  definition (PRICING.md), so these never have a line item to join through. */
  freeRecoveries: FreeLedgerEntry[];
}

/** The flagship evidence ledger for the whole account: every fee ever billed,
 *  across every invoice, plus every baseline recovery. */
export async function getBillingLedger(db: Db, accountId: string): Promise<BillingLedger> {
  const [lineItemRows, freeRows] = await Promise.all([
    db.select().from(billingLineItems).where(eq(billingLineItems.accountId, accountId)),
    db
      .select()
      .from(recoveredPayments)
      .where(
        and(eq(recoveredPayments.accountId, accountId), eq(recoveredPayments.attributionKind, "stripe_baseline")),
      ),
  ]);

  const enriched = await enrichLineItems(db, lineItemRows);

  return {
    lineItems: [...enriched].sort((a, b) => b.lineItem.createdAt.getTime() - a.lineItem.createdAt.getTime()),
    freeRecoveries: [...freeRows]
      .sort((a, b) => b.recoveredAt.getTime() - a.recoveredAt.getTime())
      .map((recoveredPayment) => ({ recoveredPayment })),
  };
}

/** Every invoice for the account, newest first (for the /billing invoice list). */
export async function listBillingInvoices(db: Db, accountId: string): Promise<BillingInvoiceRow[]> {
  const rows = await db.select().from(billingInvoices).where(eq(billingInvoices.accountId, accountId));
  return [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

export interface BillingInvoiceDetail {
  invoice: BillingInvoiceRow;
  lineItems: EnrichedLineItem[];
}

/** One invoice's own line items with their evidence. Null when the id does not
 *  exist or belongs to another account (the route 404s). */
export async function getBillingInvoiceDetail(
  db: Db,
  accountId: string,
  invoiceId: string,
): Promise<BillingInvoiceDetail | null> {
  const rows = await db
    .select()
    .from(billingInvoices)
    .where(and(eq(billingInvoices.id, invoiceId), eq(billingInvoices.accountId, accountId)))
    .limit(1);
  const invoice = rows[0];
  if (!invoice) return null;

  const lineItemRows = await db
    .select()
    .from(billingLineItems)
    .where(and(eq(billingLineItems.invoiceId, invoiceId), eq(billingLineItems.accountId, accountId)));
  const enriched = await enrichLineItems(db, lineItemRows);

  return {
    invoice,
    lineItems: [...enriched].sort((a, b) => a.lineItem.createdAt.getTime() - b.lineItem.createdAt.getTime()),
  };
}

/** The account's subscriptions, oldest first, as Recova's Subscriptions section
 *  lists them. Read-only. */
export async function listAccountSubscriptions(db: Db, accountId: string) {
  return db
    .select({
      id: accountSubscriptions.id,
      product: accountSubscriptions.product,
      status: accountSubscriptions.status,
      currentPeriodEndsAt: accountSubscriptions.currentPeriodEndsAt,
      canceledAt: accountSubscriptions.canceledAt,
    })
    .from(accountSubscriptions)
    .where(eq(accountSubscriptions.accountId, accountId))
    .orderBy(asc(accountSubscriptions.createdAt));
}
