import { beforeEach, describe, expect, it, vi } from "vitest";

import { cloudflareContext } from "~/lib/cloudflare-context";
import { authContext } from "~/lib/auth/context";

// J66, row S13: the disputes list, against Recova's real page.
//
// Recova is the spec: app/(app)/disputes/dashboard/page.tsx (blob c97c3e93),
// DisputesDashboardView.tsx (3c1b7a98) and SyncDisputeLink.tsx (d2c2a744).
// The page is a 1280px column headed "Dashboard"; a row of stat cards that
// shows on the empty state too; then either the empty card or the table
// (Customer with the email beneath, Amount, Reason, status, Deadline as "18d",
// View); then the sync control. Look is Capsomer's (Q10), teal (Q11).
//
// Dustin answered PR #75's five questions "yes ro all" (2026-10-15,
// cmsg_01Nd8kh3hkgYNYpWXrNkvBQL2LnH5XBcKc3DcWHoEsDbT6): Recova's status labels,
// mapped truthfully from Foxhound's states (1); a "Submitted by Foxhound" card
// computed from Foxhound's own data, and no "Saved vs Smart Disputes" (2); no
// Mode column, for good (3); Win rate kept (4); and "Fees owed" counting only
// fees still owed, pending or invoiced and not paid, as Recova's does (5). The
// Recovery cross-sell card is approved as not built (APPROVED-DIFFERENCES
// 2026-09-19).

// The loader reads through getDb(env); the in-memory database stands in for D1.
const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const route = await import("~/routes/app/disputes/index");
const { computeDisputeStats } = await import("~/lib/disputes/stats");
const { deadlineShort, disputeListStatus } = await import("~/lib/disputes/labels");
const { createInMemoryDb } = await import("./helpers/inmemory-db");

const NOW = Date.parse("2026-10-15T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;






describe("deadlineShort", () => {
  it("is Recova's whole-days form", () => {
    expect(deadlineShort(18, false)).toBe("18d");
    expect(deadlineShort(0, false)).toBe("0d");
    expect(deadlineShort(-2, false)).toBe("-2d");
  });

  it("is blank once resolved or with no deadline", () => {
    expect(deadlineShort(5, true)).toBe("");
    expect(deadlineShort(null, false)).toBe("");
  });
});

describe("disputeListStatus: Foxhound's states in Recova's words (question 1)", () => {
  const status = (state: string, submittedBy: string | null = null, hasEvidence = true) =>
    disputeListStatus({ state, submittedBy, hasEvidence });

  it("says Won and Lost for the two resolutions", () => {
    expect(status("resolved_won")).toEqual({ label: "Won", tone: "success" });
    expect(status("resolved_lost")).toEqual({ label: "Lost", tone: "failure" });
  });

  it("says We submitted when Foxhound submitted, Submitted externally when the merchant or Stripe did", () => {
    expect(status("submitted", "owner@example.com")).toEqual({ label: "We submitted", tone: "neutral" });
    expect(status("submitted", null)).toEqual({ label: "We submitted", tone: "neutral" });
    expect(status("submitted", "merchant_or_stripe")).toEqual({ label: "Submitted externally", tone: "neutral" });
  });

  it("says Evidence ready once Foxhound's draft holds evidence and is waiting on the merchant", () => {
    expect(status("pending_review", null, true)).toEqual({ label: "Evidence ready", tone: "neutral" });
    expect(status("approved", null, true)).toEqual({ label: "Evidence ready", tone: "neutral" });
  });

  it("keeps Foxhound's own word where no Recova label is true", () => {
    // A review with an empty draft is not "Evidence ready", and nothing in
    // Foxhound is building it, so "Building evidence" would be false too.
    expect(status("pending_review", null, false)).toEqual({ label: "Pending review", tone: "neutral" });
    // Nothing in Foxhound writes draft, and nothing builds a draft's evidence.
    expect(status("draft", null, true)).toEqual({ label: "Draft", tone: "neutral" });
  });

  it("says Unknown for a state it does not know, as Recova does", () => {
    expect(status("charge_refunded")).toEqual({ label: "Unknown", tone: "neutral" });
  });

  it("never says Stripe handling or Accepted: Foxhound records neither", () => {
    const labels = ["draft", "pending_review", "approved", "submitted", "resolved_won", "resolved_lost"].flatMap((s) =>
      [null, "merchant_or_stripe"].flatMap((by) => [true, false].map((ev) => status(s, by, ev).label)),
    );
    expect(labels).not.toContain("Stripe handling");
    expect(labels).not.toContain("Accepted");
    expect(labels).not.toContain("Building evidence");
  });
});

describe("computeDisputeStats", () => {
  const base = {
    state: "pending_review",
    amountCents: 10_000,
    currency: "usd",
    resolvedFeeCents: null as number | null,
    resolvedFeeCurrency: null as string | null,
    submittedAt: null as Date | null,
    submittedBy: null as string | null,
  };

  it("counts open disputes and keeps the money at stake per currency", () => {
    const stats = computeDisputeStats([
      { ...base, state: "draft", amountCents: 5_000 },
      { ...base, amountCents: 7_000, currency: "eur" },
      { ...base, state: "resolved_won", amountCents: 100_000 },
    ]);
    expect(stats.openCount).toBe(2);
    expect(stats.atStakeParts).toEqual([
      { currency: "usd", cents: 5_000 },
      { currency: "eur", cents: 7_000 },
    ]);
  });

  it("counts every dispute Foxhound submitted, in any state, and none the merchant or Stripe did", () => {
    const stats = computeDisputeStats([
      { ...base, state: "submitted", submittedAt: new Date(NOW), submittedBy: "owner@example.com" },
      { ...base, state: "resolved_won", submittedAt: new Date(NOW), submittedBy: "owner@example.com" },
      { ...base, state: "resolved_lost", submittedAt: new Date(NOW), submittedBy: "owner@example.com" },
      { ...base, state: "resolved_won", submittedAt: new Date(NOW), submittedBy: "merchant_or_stripe" },
      { ...base, state: "resolved_won", submittedAt: null },
      { ...base, state: "pending_review" },
    ]);
    expect(stats.submittedByFoxhoundCount).toBe(3);
  });

  it("computes no fee: Fees owed is read from the billing records by the loader", () => {
    const stats = computeDisputeStats([
      { ...base, state: "resolved_won", submittedAt: new Date(NOW), submittedBy: "owner@example.com" },
    ]);
    expect(stats).not.toHaveProperty("feesOwedParts");
  });

  it("keeps the win rate over resolved disputes only, null until one resolves", () => {
    expect(computeDisputeStats([{ ...base, state: "draft" }]).winRatePct).toBeNull();
    const stats = computeDisputeStats([
      { ...base, state: "resolved_won", submittedAt: new Date(NOW) },
      { ...base, state: "resolved_lost" },
      { ...base, state: "resolved_lost" },
      { ...base, state: "draft" },
    ]);
    expect(stats).toMatchObject({ winRatePct: 33, wonCount: 1, lostCount: 2 });
  });
});

describe("the loader", () => {
  const ACCOUNT = "acct_j66";
  let env: Env;
  let sqlite: ReturnType<typeof createInMemoryDb>["sqlite"];

  function context() {
    return {
      get(key: unknown) {
        if (key === cloudflareContext) return { env, ctx: {} as ExecutionContext, nonce: "n" };
        if (key === authContext) return { email: "owner@example.com", membership: { accountId: ACCOUNT }, isDemo: false };
        throw new Error("unexpected context key");
      },
    } as never;
  }

  function dispute(id: string, createdAt: number, deadline: number, currency = "usd", amount = 4_900) {
    sqlite
      .prepare(
        "INSERT INTO disputes (id, account_id, stripe_dispute_id, stripe_charge_id, stripe_customer_id, customer_name, amount_cents, currency, reason, status, state, evidence_deadline, created_at) VALUES (?, ?, ?, ?, ?, 'Ada', ?, ?, 'fraudulent', 'needs_response', 'pending_review', ?, ?)",
      )
      .run(id, ACCOUNT, `dp_${id}`, `ch_${id}`, `cus_${id}`, amount, currency, deadline, createdAt);
  }

  beforeEach(() => {
    const made = createInMemoryDb();
    sqlite = made.sqlite;
    harness.db = made.db;
    env = {} as Env;
    sqlite.prepare("INSERT INTO accounts (id, name, created_at) VALUES (?, 'Acme', 1000)").run(ACCOUNT);
  });

  const load = () =>
    route.loader({ context: context(), request: new Request("https://x.test/disputes"), params: {} } as never) as Promise<{
      disputes: { id: string }[];
      stats: {
        openCount: number;
        atStake: { currency: string; cents: number }[];
        submittedByFoxhoundCount: number;
        feesOwed: { currency: string; cents: number }[];
      };
      health: Record<string, number> | null;
      withEvidence: string[];
    }>;

  const OTHER = "acct_other";

  /** A won dispute Foxhound submitted, with its approval row, as billing sees it. */
  function wonBilled(id: string, account: string, feeCents: number, currency = "usd") {
    sqlite
      .prepare(
        "INSERT INTO disputes (id, account_id, stripe_dispute_id, stripe_charge_id, stripe_customer_id, customer_name, amount_cents, currency, reason, status, state, submitted_at, submitted_by, resolved_at, resolved_fee_cents, resolved_fee_currency, created_at) VALUES (?, ?, ?, ?, ?, 'Ada', ?, ?, 'fraudulent', 'needs_response', 'resolved_won', 900, 'owner@example.com', 1000, ?, ?, 800)",
      )
      .run(id, account, `dp_${id}`, `ch_${id}`, `cus_${id}`, feeCents * 5, currency, feeCents, currency);
    sqlite
      .prepare(
        "INSERT INTO dispute_approvals (id, dispute_id, account_id, approved_by_email, evidence_version_hash, approved_at) VALUES (?, ?, ?, 'owner@example.com', 'h', 900)",
      )
      .run(`appr_${id}`, id, account);
  }

  function invoice(id: string, account: string, status: string, currency = "usd") {
    sqlite
      .prepare(
        "INSERT INTO billing_invoices (id, account_id, currency, period_start, period_end, status, total_cents, idempotency_key, created_at) VALUES (?, ?, ?, 1, 2, ?, 0, ?, 3)",
      )
      .run(id, account, currency, status, `idem_${id}`);
  }

  function feeLine(id: string, invoiceId: string, account: string, disputeId: string, cents: number, currency = "usd") {
    sqlite
      .prepare(
        "INSERT INTO billing_line_items (id, invoice_id, account_id, type, currency, amount_cents, fee_cents, dispute_id, created_at) VALUES (?, ?, ?, 'dispute_fee', ?, ?, ?, ?, 4)",
      )
      .run(id, invoiceId, account, currency, cents, cents, disputeId);
  }

  function creditLine(id: string, invoiceId: string, account: string, feeLineId: string, cents: number) {
    sqlite
      .prepare(
        "INSERT INTO billing_line_items (id, invoice_id, account_id, type, currency, amount_cents, credits_line_item_id, created_at) VALUES (?, ?, ?, 'credit', 'usd', ?, ?, 5)",
      )
      .run(id, invoiceId, account, -cents, feeLineId);
  }

  const byCurrency = (rows: { currency: string; cents: number }[]) =>
    [...rows].sort((a, b) => a.currency.localeCompare(b.currency));

  it("counts the disputes Foxhound submitted", async () => {
    wonBilled("w1", ACCOUNT, 1_000);
    dispute("open", NOW - DAY, NOW + DAY);
    expect((await load()).stats.submittedByFoxhoundCount).toBe(1);
  });

  it("owes the fees still pending or invoiced, and none already paid, void or credited (question 5)", async () => {
    // Pending: a billable win with no fee line yet, at the fee the next run bills.
    wonBilled("pending", ACCOUNT, 1_500);
    // Invoiced and not yet paid: owed.
    wonBilled("invoiced", ACCOUNT, 700, "eur");
    invoice("inv_open", ACCOUNT, "finalized", "eur");
    feeLine("li_open", "inv_open", ACCOUNT, "invoiced", 700, "eur");
    // A charge that failed is still owed: the retry sweep still chases it.
    wonBilled("failed", ACCOUNT, 300);
    invoice("inv_failed", ACCOUNT, "payment_failed");
    feeLine("li_failed", "inv_failed", ACCOUNT, "failed", 300);
    // Paid: drops off, as Recova's paid fees do.
    wonBilled("paid", ACCOUNT, 900);
    invoice("inv_paid", ACCOUNT, "paid");
    feeLine("li_paid", "inv_paid", ACCOUNT, "paid", 900);
    // Void: never going to be collected.
    wonBilled("void", ACCOUNT, 400);
    invoice("inv_void", ACCOUNT, "void");
    feeLine("li_void", "inv_void", ACCOUNT, "void", 400);
    // Invoiced, then credited in full: nothing left owed.
    wonBilled("credited", ACCOUNT, 2_000);
    invoice("inv_cred", ACCOUNT, "finalized");
    feeLine("li_cred", "inv_cred", ACCOUNT, "credited", 2_000);
    invoice("inv_note", ACCOUNT, "finalized");
    creditLine("li_note", "inv_note", ACCOUNT, "li_cred", 2_000);

    expect(byCurrency((await load()).stats.feesOwed)).toEqual([
      { currency: "eur", cents: 700 },
      { currency: "usd", cents: 1_800 },
    ]);
  });

  it("owes nothing on a win Foxhound did not submit", async () => {
    sqlite
      .prepare(
        "INSERT INTO disputes (id, account_id, stripe_dispute_id, stripe_charge_id, amount_cents, currency, reason, status, state, resolved_at, created_at) VALUES ('mine', ?, 'dp_mine', 'ch_mine', 10000, 'usd', 'fraudulent', 'won', 'resolved_won', 1000, 800)",
      )
      .run(ACCOUNT);
    expect((await load()).stats.feesOwed).toEqual([]);
  });

  it("reports which disputes hold drafted evidence, so a status says Evidence ready only then", async () => {
    dispute("drafted", NOW - DAY, NOW + DAY);
    dispute("blank", NOW - 2 * DAY, NOW + DAY);
    dispute("none", NOW - 3 * DAY, NOW + DAY);
    const evidence = sqlite.prepare(
      "INSERT INTO dispute_evidence (id, dispute_id, account_id, field_name, field_value, created_at) VALUES (?, ?, ?, ?, ?, 1)",
    );
    evidence.run("e1", "drafted", ACCOUNT, "product_description", "Annual plan, delivered by email.");
    evidence.run("e2", "blank", ACCOUNT, "product_description", "   ");
    expect((await load()).withEvidence).toEqual(["drafted"]);
  });

  it("never shows another account's disputes, health scores, evidence or fees", async () => {
    sqlite.prepare("INSERT INTO accounts (id, name, created_at) VALUES (?, 'Other', 1000)").run(OTHER);
    sqlite
      .prepare(
        "INSERT INTO account_subscriptions (id, account_id, product, status, created_at) VALUES ('sub1', ?, 'intelligence', 'active', 1)",
      )
      .run(ACCOUNT);
    // Ours: one open dispute for cus_shared, with no score of its own.
    sqlite
      .prepare(
        "INSERT INTO disputes (id, account_id, stripe_dispute_id, stripe_charge_id, stripe_customer_id, customer_name, amount_cents, currency, reason, status, state, created_at) VALUES ('mine', ?, 'dp_mine', 'ch_mine', 'cus_shared', 'Ada', 4900, 'usd', 'fraudulent', 'needs_response', 'pending_review', 2000)",
      )
      .run(ACCOUNT);
    // Theirs: the same Stripe customer id, scored, with a dispute, evidence
    // under our dispute's id, a pending fee and an invoiced fee.
    sqlite
      .prepare(
        "INSERT INTO customer_context (id, account_id, stripe_customer_id, health_score, created_at, updated_at) VALUES ('cc_other', ?, 'cus_shared', 12, 1, 1)",
      )
      .run(OTHER);
    sqlite
      .prepare(
        "INSERT INTO disputes (id, account_id, stripe_dispute_id, stripe_charge_id, stripe_customer_id, customer_name, amount_cents, currency, reason, status, state, created_at) VALUES ('theirs', ?, 'dp_theirs', 'ch_theirs', 'cus_shared', 'Bob', 9900, 'usd', 'fraudulent', 'needs_response', 'pending_review', 3000)",
      )
      .run(OTHER);
    sqlite
      .prepare(
        "INSERT INTO dispute_evidence (id, dispute_id, account_id, field_name, field_value, created_at) VALUES ('e_other', 'mine', ?, 'product_description', 'Not yours.', 1)",
      )
      .run(OTHER);
    wonBilled("their_pending", OTHER, 1_100);
    wonBilled("their_invoiced", OTHER, 600);
    invoice("inv_other", OTHER, "finalized");
    feeLine("li_other", "inv_other", OTHER, "their_invoiced", 600);

    const data = await load();
    expect(data.disputes.map((d) => d.id)).toEqual(["mine"]);
    expect(data.health).toEqual({});
    expect(data.withEvidence).toEqual([]);
    expect(data.stats.openCount).toBe(1);
    expect(data.stats.atStake).toEqual([{ currency: "usd", cents: 4_900 }]);
    expect(data.stats.submittedByFoxhoundCount).toBe(0);
    expect(data.stats.feesOwed).toEqual([]);
  });

  it("lists newest first, as Recova orders by created_at, never re-sorted by deadline", async () => {
    dispute("old_near", NOW - 5 * DAY, NOW + DAY);
    dispute("new_far", NOW - DAY, NOW + 20 * DAY);
    const data = await load();
    expect(data.disputes.map((d) => d.id)).toEqual(["new_far", "old_near"]);
  });

  it("totals the money at stake per currency", async () => {
    dispute("a", NOW - DAY, NOW + DAY, "usd", 1_000);
    dispute("b", NOW - 2 * DAY, NOW + DAY, "eur", 2_000);
    dispute("c", NOW - 3 * DAY, NOW + DAY, "usd", 500);
    const data = await load();
    expect(data.stats.openCount).toBe(3);
    expect(data.stats.atStake).toEqual([
      { currency: "usd", cents: 1_500 },
      { currency: "eur", cents: 2_000 },
    ]);
  });

  it("reads health scores only when Intelligence is on", async () => {
    dispute("a", NOW - DAY, NOW + DAY);
    sqlite
      .prepare(
        "INSERT INTO customer_context (id, account_id, stripe_customer_id, health_score, created_at, updated_at) VALUES ('cc1', ?, 'cus_a', 77, 1, 1)",
      )
      .run(ACCOUNT);
    expect((await load()).health).toBeNull();

    sqlite
      .prepare(
        "INSERT INTO account_subscriptions (id, account_id, product, status, created_at) VALUES ('sub1', ?, 'intelligence', 'active', 1)",
      )
      .run(ACCOUNT);
    expect((await load()).health).toEqual({ cus_a: 77 });
  });
});
