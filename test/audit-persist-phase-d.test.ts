
import type Database from "better-sqlite3";
import type Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { runAudit, type AuditInputs, type ScopeOutcome } from "~/lib/audit/engine";
import { AUDIT_SUMMARY_FALLBACK } from "~/lib/audit/summary";

import { createInMemoryDb } from "./helpers/inmemory-db";

// SESSION 69, PHASE (d): persistence.
//
// NO MIGRATION. `audit_runs` was built with legacy's full 29-column set and has
// sat empty since; the walk found that and 363 confirmed it, so this phase is
// code only.
//
// THE PER-SCOPE STATUS LIVES IN THE NULLS, which is the claim these plants exist
// to prove. A scope that was READ stores its number, zero included; a scope that
// could NOT be read stores NULL. Without that, the round trip would flatten
// 362 ruling 2 back into legacy's lie with digits.

const harness = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const { saveAuditRun, getAuditRun } = await import(
  "~/lib/audit/persist.server"
);

const RAN_AT = new Date("2026-08-25T09:00:00.000Z");
const ACCOUNT_A = "acct_alpha";
const ACCOUNT_B = "acct_beta";

const ok = <T>(data: T[]): ScopeOutcome<T[]> => ({ ok: true, data });
const failedRead = (reason: string): ScopeOutcome<never[]> => ({ ok: false, reason });

const invoice = (o: Record<string, unknown>) =>
  ({ amount_due: 0, currency: "usd", ...o }) as unknown as Stripe.Invoice;

function auditWith(over: Partial<AuditInputs> = {}) {
  return runAudit({
    stripeAccountId: "acct_stripe_x",
    lookbackDays: 90,
    ranAt: RAN_AT,
    reads: {
      uncollectibleInvoices: ok<Stripe.Invoice>([]),
      openInvoices: ok<Stripe.Invoice>([]),
      subscriptions: ok<Stripe.Subscription>([]),
      disputes: ok<Stripe.Dispute>([]),
      cardUpdaterEvents: ok<Stripe.Event>([]),
      ...over,
    },
  });
}

let sqlite: Database.Database;
let db: ReturnType<typeof createInMemoryDb>["db"];

beforeEach(() => {
  ({ sqlite, db } = createInMemoryDb());
  harness.db = db;
  for (const id of [ACCOUNT_A, ACCOUNT_B]) {
    sqlite
      .prepare("INSERT INTO accounts (id, name, created_at) VALUES (?, ?, 1000)")
      .run(id, id);
  }
});

const context = (over: Record<string, unknown> = {}) => ({
  accountId: ACCOUNT_A,
  isAuthenticated: true,
  summary: "One. Two. Three.",
  now: RAN_AT,
  ...over,
});

describe("PLANT 6: end to end, and a failed scope visible at every layer", () => {
  it("engine to prompt to save to read-back, with one scope unread throughout", async () => {
    // The whole chain on fixtures. One read fails and the failure has to survive
    // four hand-offs without becoming a zero at any of them, which is the single
    // property 362 ruling 2 exists for.
    const { buildAuditSummaryPrompt } = await import("~/lib/audit/summary");
    const { generateAuditSummary } = await import("~/lib/audit/summary.server");

    const result = auditWith({
      uncollectibleInvoices: ok<Stripe.Invoice>([invoice({ amount_due: 50_000 })]),
      disputes: failedRead("Could not read disputes from Stripe: rate limited"),
    });

    // LAYER 1, the engine.
    expect(result.failedInvoices.ok).toBe(true);
    expect(result.disputes.ok).toBe(false);

    // LAYER 2, the prompt.
    const prompt = buildAuditSummaryPrompt(result);
    expect(prompt).toContain("Failed invoices (last 90 days): $500.00 across 1 invoices");
    expect(prompt).toContain("Open disputes: could not be read");

    // LAYER 3, the summary call. No key here, so the fallback arm, which is the
    // arm a merchant sees today under launch blocker 2.
    const summary = await generateAuditSummary({} as Env, result);
    expect(summary.source).toBe("fallback");

    // LAYER 4, the save and the read-back.
    const id = await saveAuditRun({} as Env, result, context({ summary: summary.summary }));
    const row = (await getAuditRun(db, ACCOUNT_A, id))!;
    expect(row.failedInvoicesCents).toBe(50_000);
    expect(row.openDisputesCount).toBeNull();
    expect(row.aiSummary).toBe(AUDIT_SUMMARY_FALLBACK);
  });
});
