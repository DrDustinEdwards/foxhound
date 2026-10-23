
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

const { saveAuditRun, getAuditRun, listAuditRuns, buildAuditRunRow } = await import(
  "~/lib/audit/persist.server"
);

const RAN_AT = new Date("2026-08-25T09:00:00.000Z");
const ACCOUNT_A = "acct_alpha";
const ACCOUNT_B = "acct_beta";

const ok = <T>(data: T[]): ScopeOutcome<T[]> => ({ ok: true, data });
const failedRead = (reason: string): ScopeOutcome<never[]> => ({ ok: false, reason });

const invoice = (o: Record<string, unknown>) =>
  ({ amount_due: 0, currency: "usd", ...o }) as unknown as Stripe.Invoice;
const dispute = (o: Record<string, unknown>) =>
  ({ amount: 0, currency: "usd", ...o }) as unknown as Stripe.Dispute;

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

describe("PLANT 1: a run round-trips", () => {
  it("saves every scope and reads it back by id", async () => {
    const result = auditWith({
      uncollectibleInvoices: ok<Stripe.Invoice>([
        invoice({ amount_due: 12_300, last_finalization_error: { decline_code: "expired_card" } }),
      ]),
      disputes: ok<Stripe.Dispute>([dispute({ status: "needs_response", amount: 4_500 })]),
    });

    const id = await saveAuditRun({} as Env, result, context());
    const row = await getAuditRun(db, ACCOUNT_A, id);

    expect(row).not.toBeNull();
    expect(row!.stripeAccountId).toBe("acct_stripe_x");
    expect(row!.lookbackDays).toBe(90);
    expect(row!.failedInvoicesCount).toBe(1);
    expect(row!.failedInvoicesCents).toBe(12_300);
    expect(row!.openDisputesCount).toBe(1);
    expect(row!.openDisputesCents).toBe(4_500);
    expect(row!.aiSummary).toBe("One. Two. Three.");
    expect(row!.isAuthenticated).toBe(true);
    expect(row!.currency).toBe("usd");
    // The category breakdown survives as JSON, keyed by Foxhound's six.
    expect(row!.declineBreakdown).toMatchObject({ expired: 12_300, soft: 0, revoked: 0 });
  });

  it("the fallback summary is stored like any other, since a run without one reads as broken", async () => {
    const id = await saveAuditRun(
      {} as Env,
      auditWith(),
      context({ summary: AUDIT_SUMMARY_FALLBACK }),
    );
    expect((await getAuditRun(db, ACCOUNT_A, id))!.aiSummary).toBe(AUDIT_SUMMARY_FALLBACK);
  });
});

describe("PLANT 2: THE PER-SCOPE STATUS SURVIVES AS NULL VERSUS A NUMBER", () => {
  it("a read scope with nothing in it stores ZERO", async () => {
    const id = await saveAuditRun({} as Env, auditWith(), context());
    const row = (await getAuditRun(db, ACCOUNT_A, id))!;
    expect(row.openDisputesCount).toBe(0);
    expect(row.mrrCents).toBe(0);
  });

  it("A SCOPE THAT COULD NOT BE READ STORES NULL, which is the whole distinction", async () => {
    // Without this, the round trip flattens 362 ruling 2 back into legacy's
    // behaviour: a failed disputes call rendering as "no open disputes".
    const id = await saveAuditRun(
      {} as Env,
      auditWith({
        disputes: failedRead("Could not read disputes from Stripe: rate limited"),
        subscriptions: failedRead("subs unavailable"),
      }),
      context(),
    );
    const row = (await getAuditRun(db, ACCOUNT_A, id))!;

    expect(row.openDisputesCount).toBeNull();
    expect(row.openDisputesCents).toBeNull();
    expect(row.disputesWon).toBeNull();
    // Subscriptions feed three scopes, so all three go null together.
    expect(row.expiringCardsCount).toBeNull();
    expect(row.pastDueSubscriptionsCount).toBeNull();
    expect(row.mrrCents).toBeNull();
    // And the scopes that WERE read still carry their numbers.
    expect(row.failedInvoicesCount).toBe(0);
  });

  it("the Card Updater's ambiguous NULL is disambiguated by its event count", async () => {
    // `card_updater_advisory` is legitimately NULL when no advisory fires, so it
    // cannot carry the status alone. `card_updater_events_in_window` is NULL
    // only on failure, and the pair separates the two cases.
    const readOk = (await getAuditRun(
      db,
      ACCOUNT_A,
      await saveAuditRun({} as Env, auditWith(), context()),
    ))!;
    expect(readOk.cardUpdaterAdvisory).toBeNull();
    expect(readOk.cardUpdaterEventsInWindow).toBe(0);

    const readFailed = (await getAuditRun(
      db,
      ACCOUNT_A,
      await saveAuditRun(
        {} as Env,
        auditWith({ cardUpdaterEvents: failedRead("events unavailable") }),
        context(),
      ),
    ))!;
    expect(readFailed.cardUpdaterAdvisory).toBeNull();
    expect(readFailed.cardUpdaterEventsInWindow).toBeNull();
  });
});

describe("PLANT 3: a save is history, not a cache", () => {
  it("a second save is a SECOND ROW, as legacy has it", async () => {
    const first = await saveAuditRun({} as Env, auditWith(), context());
    const second = await saveAuditRun({} as Env, auditWith(), context());
    expect(first).not.toBe(second);
    expect(await listAuditRuns(db, ACCOUNT_A)).toHaveLength(2);
  });

  it("history comes back newest first", async () => {
    await saveAuditRun(
      {} as Env,
      runAudit({
        stripeAccountId: "acct_old",
        lookbackDays: 90,
        ranAt: new Date(RAN_AT.getTime() - 86_400_000),
        reads: {
          uncollectibleInvoices: ok<Stripe.Invoice>([]),
          openInvoices: ok<Stripe.Invoice>([]),
          subscriptions: ok<Stripe.Subscription>([]),
          disputes: ok<Stripe.Dispute>([]),
          cardUpdaterEvents: ok<Stripe.Event>([]),
        },
      }),
      context(),
    );
    await saveAuditRun({} as Env, auditWith(), context());
    const rows = await listAuditRuns(db, ACCOUNT_A);
    expect(rows.map((r) => r.stripeAccountId)).toEqual(["acct_stripe_x", "acct_old"]);
  });
});

describe("PLANT 4: the read-back is account-scoped", () => {
  it("ANOTHER ACCOUNT'S RUN ID RETURNS NULL, never its numbers", async () => {
    // Two accounts in the fixture (352 binding 4): with one, every wrong answer
    // is also the right one.
    const mine = await saveAuditRun({} as Env, auditWith(), context());
    const theirs = await saveAuditRun({} as Env, auditWith(), context({ accountId: ACCOUNT_B }));

    expect(await getAuditRun(db, ACCOUNT_A, mine)).not.toBeNull();
    expect(await getAuditRun(db, ACCOUNT_A, theirs)).toBeNull();
    expect(await getAuditRun(db, ACCOUNT_B, theirs)).not.toBeNull();
  });

  it("and the history never blends the two", async () => {
    await saveAuditRun({} as Env, auditWith(), context());
    await saveAuditRun({} as Env, auditWith(), context({ accountId: ACCOUNT_B }));
    await saveAuditRun({} as Env, auditWith(), context({ accountId: ACCOUNT_B }));
    expect(await listAuditRuns(db, ACCOUNT_A)).toHaveLength(1);
    expect(await listAuditRuns(db, ACCOUNT_B)).toHaveLength(2);
  });
});

describe("PLANT 5: the audit is still free", () => {

  it("the row builder is pure, so a plant drives the real mapping", () => {
    const row = buildAuditRunRow(auditWith(), context());
    expect(row.accountId).toBe(ACCOUNT_A);
    expect(row.runAt).toEqual(RAN_AT);
    // 29 columns from legacy's insert, plus createdAt which legacy's database
    // defaults and Foxhound's schema requires.
    expect(Object.keys(row).length).toBeGreaterThanOrEqual(28);
  });
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
