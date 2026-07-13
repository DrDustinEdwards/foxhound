import type { BatchItem } from "drizzle-orm/batch";

import {
  accountBillingEligibleCondition,
  getBillableDisputes,
  getBillableRecoveries,
} from "~/db/billable";
import type { Db, MoneyWriteBatch } from "~/db";
import { accounts, billingInvoices, billingLineItems, getDb } from "~/db";
import { executeMoneyWrite } from "~/lib/money/execute";

import { disputeFeeCents, recoveryFeeCents } from "./fees";

// The monthly billing run (PRICING.md billing mechanics + SCHEMA.md billing).
// One invoice per account per currency, its line items FK-linked to their
// evidence (recovered payment / dispute), committed as ONE atomic money-write
// batch through the per-account Durable Object.
//
// Two-layer idempotency:
//   1. billing_invoices.idempotency_key is unique and deterministic per
//      (account, currency, period). A concurrent or repeated run collides on it
//      and the whole batch rolls back (applied=false). The DO storage fast path
//      short-circuits the common repeat before any SQL runs.
//   2. billing_line_items has a unique index per recovered_payment and per
//      dispute, so a recovery/dispute can never be billed twice even across
//      differently-keyed invoices. The billable queries also exclude
//      already-billed rows, so a second run's set is empty by construction.
//
// No orphan charges: every recovery_fee / dispute_fee row carries its evidence FK,
// and the invoice + line items commit atomically or not at all.

export interface BillingPeriod {
  periodStart: Date;
  /** Exclusive: the first instant of the current month. */
  periodEnd: Date;
  /** YYYY-MM of the prior calendar month; drives the idempotency key. */
  periodKey: string;
}

/** The prior calendar month relative to `nowMs` (UTC). Pure. */
export function computeBillingPeriod(nowMs: number): BillingPeriod {
  const now = new Date(nowMs);
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth(); // 0-11, current month
  const startY = m === 0 ? y - 1 : y;
  const startM = m === 0 ? 11 : m - 1;
  return {
    periodStart: new Date(Date.UTC(startY, startM, 1)),
    periodEnd: new Date(Date.UTC(y, m, 1)),
    periodKey: `${startY}-${String(startM + 1).padStart(2, "0")}`,
  };
}

export interface BillableRecoveryLite {
  id: string;
  amountCents: number;
}
export interface BillableDisputeLite {
  id: string;
  amountCents: number;
  /** Cap-applied fee snapshotted at resolution; falls back to computed if absent. */
  resolvedFeeCents: number | null;
}

export interface InvoiceBatchInput {
  invoiceId: string;
  accountId: string;
  currency: string;
  periodStart: Date;
  periodEnd: Date;
  idempotencyKey: string;
  createdAt: Date;
  recoveries: BillableRecoveryLite[];
  disputes: BillableDisputeLite[];
}

export interface BuiltInvoiceBatch {
  batch: MoneyWriteBatch;
  totalCents: number;
  lineItemCount: number;
}

/**
 * Builds the atomic invoice batch (the billing_invoices row followed by its
 * billing_line_items). The invoice is first so the line items' FK resolves inside
 * the same transaction. Pure and unit-testable; the caller supplies the invoice id
 * so the linkage is deterministic.
 */
export function buildBillingInvoiceBatch(db: Db, input: InvoiceBatchInput): BuiltInvoiceBatch {
  const lineItems: BatchItem<"sqlite">[] = [];
  let total = 0;

  for (const r of input.recoveries) {
    const fee = recoveryFeeCents(r.amountCents);
    total += fee;
    lineItems.push(
      db.insert(billingLineItems).values({
        invoiceId: input.invoiceId,
        accountId: input.accountId,
        type: "recovery_fee",
        currency: input.currency,
        amountCents: fee,
        feeCents: fee,
        recoveredPaymentId: r.id,
        description: "Recovery fee",
        createdAt: input.createdAt,
      }),
    );
  }

  for (const d of input.disputes) {
    const fee = d.resolvedFeeCents ?? disputeFeeCents(d.amountCents);
    total += fee;
    lineItems.push(
      db.insert(billingLineItems).values({
        invoiceId: input.invoiceId,
        accountId: input.accountId,
        type: "dispute_fee",
        currency: input.currency,
        amountCents: fee,
        feeCents: fee,
        disputeId: d.id,
        description: "Dispute fee",
        createdAt: input.createdAt,
      }),
    );
  }

  const invoiceInsert = db.insert(billingInvoices).values({
    id: input.invoiceId,
    accountId: input.accountId,
    currency: input.currency,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    status: "draft",
    totalCents: total,
    idempotencyKey: input.idempotencyKey,
    createdAt: input.createdAt,
  });

  const batch: MoneyWriteBatch = [invoiceInsert, ...lineItems];
  return { batch, totalCents: total, lineItemCount: lineItems.length };
}

export interface InvoiceRunResult {
  currency: string;
  idempotencyKey: string;
  applied: boolean;
  totalCents: number;
  lineItemCount: number;
}
export interface AccountBillingResult {
  accountId: string;
  invoices: InvoiceRunResult[];
}

/**
 * Bills one account for the prior period: reads the billable recoveries + won
 * disputes, groups by currency, and commits one atomic invoice per currency.
 * Returns per-currency results (applied=false means an idempotent no-op).
 */
export async function runAccountBilling(
  env: Env,
  opts: { accountId: string; nowMs: number },
): Promise<AccountBillingResult> {
  const db = getDb(env);
  const { accountId, nowMs } = opts;
  const period = computeBillingPeriod(nowMs);
  const createdAt = new Date(nowMs);

  const recoveries = await getBillableRecoveries(db, accountId, nowMs);
  const disputes = await getBillableDisputes(db, accountId, nowMs);

  const currencies = [
    ...new Set([...recoveries.map((r) => r.currency), ...disputes.map((d) => d.currency)]),
  ];

  const invoices: InvoiceRunResult[] = [];
  for (const currency of currencies) {
    const cr: BillableRecoveryLite[] = recoveries
      .filter((r) => r.currency === currency)
      .map((r) => ({ id: r.id, amountCents: r.amountCents }));
    const cd: BillableDisputeLite[] = disputes
      .filter((d) => d.currency === currency)
      .map((d) => ({
        id: d.id,
        amountCents: d.amountCents,
        resolvedFeeCents: d.resolvedFeeCents ?? null,
      }));
    if (cr.length === 0 && cd.length === 0) continue;

    const idempotencyKey = `billing:${accountId}:${currency}:${period.periodKey}`;
    let summary = { totalCents: 0, lineItemCount: 0 };
    const { applied } = await executeMoneyWrite(env, {
      accountId,
      idempotencyKey,
      build: (bdb) => {
        const built = buildBillingInvoiceBatch(bdb, {
          invoiceId: crypto.randomUUID(),
          accountId,
          currency,
          periodStart: period.periodStart,
          periodEnd: period.periodEnd,
          idempotencyKey,
          createdAt,
          recoveries: cr,
          disputes: cd,
        });
        summary = { totalCents: built.totalCents, lineItemCount: built.lineItemCount };
        return built.batch;
      },
    });
    invoices.push({
      currency,
      idempotencyKey,
      applied,
      totalCents: summary.totalCents,
      lineItemCount: summary.lineItemCount,
    });
  }

  return { accountId, invoices };
}

/**
 * The full monthly run: every billing-eligible account (not exempt, not paused,
 * not a demo account) billed for the prior period. This is the entry point the
 * Phase 4e Cron Trigger invokes. Failures on one account do not abort the rest.
 */
export async function runMonthlyBilling(
  env: Env,
  nowMs: number,
): Promise<AccountBillingResult[]> {
  const db = getDb(env);
  const eligible = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(accountBillingEligibleCondition());

  const results: AccountBillingResult[] = [];
  for (const { id } of eligible) {
    try {
      results.push(await runAccountBilling(env, { accountId: id, nowMs }));
    } catch (err) {
      results.push({
        accountId: id,
        invoices: [],
      });
      // Surface the failure without aborting the run; the cron logs the aggregate.
      console.error(`billing run failed for account ${id}:`, err instanceof Error ? err.message : err);
    }
  }
  return results;
}
