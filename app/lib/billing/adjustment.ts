import type { Db, MoneyWriteBatch } from "~/db";
import { billingInvoices, billingLineItems, getDb } from "~/db";
import { logAdminAction } from "~/lib/admin/audit.server";
import { executeMoneyWrite } from "~/lib/money/execute";

// Manual billing adjustments (admin Pass 2; PRICING.md "a manual, admin-audited
// adjustment line item exists for discretionary goodwill or error correction;
// it is a lever, not a system"). An adjustment is its OWN standalone invoice
// (not appended to a monthly-run invoice, which may already be finalized or
// Stripe-charged): one billing_invoices row + one billing_line_items row
// (type='adjustment', signed amountCents), committed atomically through the
// per-account money-write DO like every other billing write (run.ts). It NEVER
// touches Stripe (stripe-invoice.ts's STRIPE_CHARGEABLE_TYPES excludes
// 'adjustment'), so it can never create a charge or a refund on a customer's
// card - corrections are entirely on Foxhound's own fee ledger.
//
// The admin_audit_log row is written FIRST, as its own plain insert (mirrors
// every other admin action's audit write, audit.server.ts), and its id is
// threaded into the DO batch as adminAuditLogId. This satisfies the DB-enforced
// invariant (schema.ts billing_line_items_adjustment_audit_ck: an adjustment
// line item without an admin_audit_log_id is a constraint violation, not just
// an app-level convention) without needing the audit write itself inside the
// DO batch.

interface AdjustmentInvoiceInput {
  invoiceId: string;
  accountId: string;
  currency: string;
  /** Signed minor units: negative credits the merchant, positive corrects a fee upward. */
  amountCents: number;
  description: string;
  adminAuditLogId: string;
  createdAt: Date;
  idempotencyKey: string;
}

/** Pure batch builder, unit-testable like buildBillingInvoiceBatch (run.ts). */
function buildAdjustmentInvoiceBatch(db: Db, input: AdjustmentInvoiceInput): MoneyWriteBatch {
  return [
    db.insert(billingInvoices).values({
      id: input.invoiceId,
      accountId: input.accountId,
      currency: input.currency,
      // A point-in-time manual entry, not a monthly period: start and end are
      // the same instant rather than a real billing-period range.
      periodStart: input.createdAt,
      periodEnd: input.createdAt,
      status: "draft",
      totalCents: input.amountCents,
      idempotencyKey: input.idempotencyKey,
      createdAt: input.createdAt,
    }),
    db.insert(billingLineItems).values({
      id: crypto.randomUUID(),
      invoiceId: input.invoiceId,
      accountId: input.accountId,
      type: "adjustment",
      currency: input.currency,
      amountCents: input.amountCents,
      feeCents: null,
      recoveredPaymentId: null,
      disputeId: null,
      adminAuditLogId: input.adminAuditLogId,
      description: input.description,
      createdAt: input.createdAt,
    }),
  ];
}

export interface CreateAdjustmentInput {
  accountId: string;
  currency: string;
  amountCents: number;
  description: string;
  actorEmail: string;
  /** Stable client-supplied token (a hidden form field minted at form render,
   *  rotated by the post-submit loader revalidation). It is the idempotency
   *  anchor: a double-submitted or retried POST carries the SAME token, so the
   *  derived key collides and the write no-ops instead of double-crediting. A
   *  deliberate second adjustment comes from a fresh render with a fresh token. */
  idempotencyToken: string;
  now: Date;
}

export interface CreateAdjustmentResult {
  invoiceId: string;
  applied: boolean;
}

/** Injected IO, so the DO-routed money-write can be driven through the real
 *  SerialMoneyCommitter + an in-memory sqlite in tests (mirrors cancelMerchant's
 *  deps in merchants.server.ts). Both default to the real bindings. */
export interface CreateAdjustmentDeps {
  db: Db;
  execute: typeof executeMoneyWrite;
}

/** Operator entry point: audit-log first (plain insert), then the invoice +
 *  line item as one atomic DO-routed batch. Never a raw money-write outside
 *  the DO. Idempotent on `idempotencyToken`: the key is derived from it (not a
 *  fresh per-call id), matching the billing run's stable
 *  `billing:${account}:${currency}:${period}` key (billing/run.ts), so a
 *  duplicate submit is deduped by the DO seen-set and, as the exactly-once
 *  backstop, the billing_invoices idempotency unique index. */
export async function createAdjustment(
  env: Env,
  input: CreateAdjustmentInput,
  deps: Partial<CreateAdjustmentDeps> = {},
): Promise<CreateAdjustmentResult> {
  const db = deps.db ?? getDb(env);
  const execute = deps.execute ?? executeMoneyWrite;

  const idempotencyKey = `adjustment:${input.accountId}:${input.idempotencyToken}`;
  const invoiceId = crypto.randomUUID();

  // Audit first (the line item FKs it; schema CHECK). A deduped replay still
  // records the operator's attempt here (append-only), while creating no second
  // credit below.
  const auditLogId = await logAdminAction(db, {
    actorEmail: input.actorEmail,
    action: "billing.adjustment.create",
    targetEmail: null,
    metadata: {
      accountId: input.accountId,
      amountCents: input.amountCents,
      currency: input.currency,
      description: input.description,
    },
  });

  const { applied } = await execute(env, {
    accountId: input.accountId,
    idempotencyKey,
    build: (bdb) =>
      buildAdjustmentInvoiceBatch(bdb, {
        invoiceId,
        accountId: input.accountId,
        currency: input.currency,
        amountCents: input.amountCents,
        description: input.description,
        adminAuditLogId: auditLogId,
        createdAt: input.now,
        idempotencyKey,
      }),
  });

  return { invoiceId, applied };
}
