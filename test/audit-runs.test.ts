import type Database from "better-sqlite3";
import type Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { showDisputesSection } from "~/components/audit/sections";

import { runAudit, type AuditInputs, type ScopeOutcome } from "~/lib/audit/engine";
import { toAuditRunView, toStoredAuditRun } from "~/lib/audit/render";
import { AUDIT_SUMMARY_FALLBACK } from "~/lib/audit/summary";
import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";

import { createInMemoryDb } from "./helpers/inmemory-db";

// Saved audit runs, through the real loaders with two accounts in every fixture.
// A scope that could not be read is stored as NULL and must never render as a zero.

const harness = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const { saveAuditRun } = await import("~/lib/audit/persist.server");
const history = await import("~/routes/app/audit/dashboard");
const runPage = await import("~/routes/app/audit/run");

const RAN_AT = new Date("2026-08-25T09:00:00.000Z");
const ACCOUNT_A = "acct_alpha";
const ACCOUNT_B = "acct_beta";

const ok = <T>(data: T[]): ScopeOutcome<T[]> => ({ ok: true, data });
const failedRead = (reason: string): ScopeOutcome<never[]> => ({ ok: false, reason });

const invoice = (o: Record<string, unknown>) =>
  ({ amount_due: 0, currency: "usd", ...o }) as unknown as Stripe.Invoice;
const dispute = (o: Record<string, unknown>) =>
  ({ amount: 0, currency: "usd", ...o }) as unknown as Stripe.Dispute;

function auditWith(over: Partial<AuditInputs> = {}, ranAt = RAN_AT) {
  return runAudit({
    stripeAccountId: "acct_stripe_x",
    lookbackDays: 90,
    ranAt,
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
    sqlite.prepare("INSERT INTO accounts (id, name, created_at) VALUES (?, ?, 1000)").run(id, id);
  }
});

function contextFor(accountId: string): unknown {
  return {
    get(key: unknown) {
      if (key === cloudflareContext) {
        return { env: {} as Env, ctx: {} as ExecutionContext };
      }
      if (key === authContext) {
        return {
          userId: "user_1",
          userName: "user_1",
          email: "owner@alpha.test",
          membership: { memberId: "m", accountId, accountName: accountId, role: "owner" },
          memberships: [],
          activeAccountId: accountId,
          isAdmin: false,
          isDemo: false,
          demoSignedIn: false,
        };
      }
      throw new Error("unexpected context key");
    },
  };
}

const save = (accountId: string, result = auditWith(), summary = "One. Two. Three.") =>
  saveAuditRun({} as Env, result, { accountId, isAuthenticated: true, summary, now: RAN_AT });

const loadHistory = (accountId: string) =>
  history.loader({
    context: contextFor(accountId),
    request: new Request("https://foxhoundapp.test/audit/dashboard"),
    params: {},
  } as never) as Promise<{
    runs: {
      id: string;
      failedInvoices: unknown[] | null;
      openDisputes: unknown[] | null;
      mrr: unknown[] | null;
    }[];
  }>;

const loadRun = (accountId: string, id: string) =>
  runPage.loader({
    context: contextFor(accountId),
    request: new Request("https://foxhoundapp.test/audit/results/x"),
    params: { id },
  } as never);

describe("the history surface", () => {
  it("carries a NULL through to the loader rather than coalescing it", async () => {
    await save(ACCOUNT_A, auditWith({ subscriptions: failedRead("subs unavailable") }));
    const { runs } = await loadHistory(ACCOUNT_A);
    // MRR comes from the subscriptions read, so it is null, not 0.
    expect(runs[0].failedInvoices).toEqual([]);
    expect(runs[0].mrr).toBeNull();
  });
});

describe("the stored-run surface", () => {
  it("reads one run and maps every scope", async () => {
    const id = await save(
      ACCOUNT_A,
      auditWith({
        uncollectibleInvoices: ok<Stripe.Invoice>([
          invoice({
            amount_due: 25_000,
            last_finalization_error: { decline_code: "expired_card" },
          }),
        ]),
        disputes: ok<Stripe.Dispute>([dispute({ status: "needs_response", amount: 9_000 })]),
      }),
    );
    const { run } = (await loadRun(ACCOUNT_A, id)) as { run: ReturnType<typeof toStoredAuditRun> };
    expect(run.failedInvoices).toMatchObject({
      count: 1,
      totals: [{ currency: "usd", cents: 25_000 }],
    });
    expect(run.failedInvoices!.byCategory.expired).toEqual([{ currency: "usd", cents: 25_000 }]);
    expect(run.disputes!.open).toEqual({ count: 1, totals: [{ currency: "usd", cents: 9_000 }] });
    expect(run.health!.mrr).toEqual([]);
    expect(run.summary).toBe("One. Two. Three.");
  });

  it("A SCOPE THAT COULD NOT BE READ ARRIVES AS null, never as a zero", async () => {
    const id = await save(
      ACCOUNT_A,
      auditWith({
        disputes: failedRead("Could not read disputes from Stripe: rate limited"),
        subscriptions: failedRead("subs unavailable"),
      }),
    );
    const { run } = (await loadRun(ACCOUNT_A, id)) as { run: ReturnType<typeof toStoredAuditRun> };
    expect(run.disputes).toBeNull();
    expect(run.expiringCards).toBeNull();
    expect(run.pastDueSubscriptions).toBeNull();
    expect(run.health).toBeNull();
    // And a scope that WAS read still carries its numbers, including a real zero.
    expect(run.failedInvoices).toMatchObject({ count: 0, totals: [] });
  });

  it("404s on an id that does not exist and on another account's run", async () => {
    const theirs = await save(ACCOUNT_B);
    await expect(loadRun(ACCOUNT_A, "nope")).rejects.toMatchObject({ status: 404 });
    await expect(loadRun(ACCOUNT_A, theirs)).rejects.toMatchObject({ status: 404 });
  });
});

describe("the Card Updater's two nulls stay apart", () => {
  it("an advisory that did not fire is not a scope that was not read", async () => {
    const fired = await save(ACCOUNT_A, auditWith());
    const notRead = await save(
      ACCOUNT_A,
      auditWith({ cardUpdaterEvents: failedRead("events unavailable") }),
    );
    const a = (await loadRun(ACCOUNT_A, fired)) as { run: ReturnType<typeof toStoredAuditRun> };
    const b = (await loadRun(ACCOUNT_A, notRead)) as { run: ReturnType<typeof toStoredAuditRun> };
    expect(a.run.cardUpdater).toMatchObject({ eventsInWindow: 0, advisory: null });
    expect(b.run.cardUpdater).toBeNull();
  });
});

describe("the disputes section", () => {
  it("is left off when every dispute figure is zero, and stays when the read failed", () => {
    const view = (over: Partial<AuditInputs> = {}) => toAuditRunView(auditWith(over), "s");
    expect(showDisputesSection(view())).toBe(false);
    expect(showDisputesSection(view({ disputes: ok([dispute({ status: "won" })]) as never }))).toBe(
      true,
    );
    expect(showDisputesSection(view({ disputes: failedRead("rate limited") }))).toBe(true);
  });
});

describe("persistence", () => {
  it("a failed scope survives engine, prompt, summary, save and read-back as NULL", async () => {
    const { buildAuditSummaryPrompt } = await import("~/lib/audit/summary");
    const { generateAuditSummary } = await import("~/lib/audit/summary.server");
    const { getAuditRun } = await import("~/lib/audit/persist.server");

    const result = auditWith({
      uncollectibleInvoices: ok<Stripe.Invoice>([invoice({ amount_due: 50_000 })]),
      disputes: failedRead("Could not read disputes from Stripe: rate limited"),
    });
    const prompt = buildAuditSummaryPrompt(result);
    expect(prompt).toContain("Failed invoices (last 90 days): $500.00 across 1 invoices");
    expect(prompt).toContain("Open disputes: could not be read");

    // No key here, so the fallback arm.
    const summary = await generateAuditSummary({} as Env, result);
    expect(summary.source).toBe("fallback");
    const id = await save(ACCOUNT_A, result, summary.summary);
    const row = (await getAuditRun(db, ACCOUNT_A, id))!;
    expect(row.failedInvoicesCents).toBe(50_000);
    expect(row.openDisputesCount).toBeNull();
    expect(row.aiSummary).toBe(AUDIT_SUMMARY_FALLBACK);
  });
});

describe("the saved run's live figures, scoped to the account", () => {
  const failed = (accountId: string, id: string, status: string) =>
    sqlite
      .prepare(
        `INSERT INTO failed_payments (id, account_id, stripe_event_id, stripe_invoice_id, stripe_customer_id, customer_email, amount_cents, currency, decline_category, status, detected_at)
         VALUES (?, ?, ?, ?, 'cus_1', 'c@example.com', 1000, 'usd', 'soft', ?, 1000)`,
      )
      .run(id, accountId, `evt_${id}`, `in_${id}`, status);

  const disputeRow = (accountId: string, id: string, state: string, submittedBy: string | null) =>
    sqlite
      .prepare(
        `INSERT INTO disputes (id, account_id, stripe_dispute_id, stripe_charge_id, amount_cents, currency, reason, status, state, submitted_at, submitted_by, created_at)
         VALUES (?, ?, ?, 'ch_1', 1000, 'usd', 'fraudulent', 'lost', ?, ?, ?, 1000)`,
      )
      .run(id, accountId, `dp_${id}`, state, submittedBy ? 2000 : null, submittedBy);

  type Live = {
    run: { id: string };
    activeSequences: number | null;
    recoveryRatePct: number | null;
    foxhoundWinRate: number | null;
  };

  it("counts active sequences, the lifetime recovery rate and Foxhound's win rate for this account only", async () => {
    const id = await save(ACCOUNT_A);
    failed(ACCOUNT_A, "f1", "active");
    failed(ACCOUNT_A, "f2", "recovered");
    failed(ACCOUNT_A, "f3", "recovered");
    failed(ACCOUNT_A, "f4", "failed_unrecovered");
    failed(ACCOUNT_B, "f5", "active");
    failed(ACCOUNT_B, "f6", "active");
    disputeRow(ACCOUNT_A, "d1", "resolved_won", "owner@alpha.test");
    disputeRow(ACCOUNT_A, "d2", "resolved_lost", "owner@alpha.test");
    disputeRow(ACCOUNT_A, "d3", "resolved_won", "merchant_or_stripe");
    disputeRow(ACCOUNT_B, "d4", "resolved_lost", "owner@beta.test");

    const data = (await loadRun(ACCOUNT_A, id)) as Live;
    expect(data.activeSequences).toBe(1);
    expect(data.recoveryRatePct).toBe(50);
    // Of the two Foxhound submitted and that resolved, one won.
    expect(data.foxhoundWinRate).toBe(50);
  });

  it("an account Foxhound has submitted nothing for has no win rate, not 0%", async () => {
    const id = await save(ACCOUNT_B);
    disputeRow(ACCOUNT_A, "d1", "resolved_won", "owner@alpha.test");
    const data = (await loadRun(ACCOUNT_B, id)) as Live;
    expect(data.foxhoundWinRate).toBeNull();
    expect(data.recoveryRatePct).toBeNull();
  });

  it("a failed live-figure read logs the whole error and still renders the saved run", async () => {
    const id = await save(ACCOUNT_A);
    sqlite.exec("PRAGMA foreign_keys = OFF; DROP TABLE disputes;");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const data = (await loadRun(ACCOUNT_A, id)) as Live;
      expect(data.run.id).toBe(id);
      expect(data.activeSequences).toBeNull();
      expect(data.recoveryRatePct).toBeNull();
      expect(data.foxhoundWinRate).toBeNull();
      expect(error).toHaveBeenCalledWith(expect.any(String), expect.any(Error));
    } finally {
      error.mockRestore();
    }
  });
});

describe("the history page's settings", () => {
  const callAction = (accountId: string, form: Record<string, string>) => {
    const body = new FormData();
    for (const [k, v] of Object.entries(form)) body.set(k, v);
    return history.action({
      request: new Request("https://foxhoundapp.test/audit/dashboard", { method: "POST", body }),
      context: contextFor(accountId),
      params: {},
    } as never) as Promise<{ data: Record<string, unknown>; init: { status?: number } | null }>;
  };
  const loadSettings = async (accountId: string) =>
    (
      (await history.loader({
        request: new Request("https://foxhoundapp.test/audit/dashboard"),
        context: contextFor(accountId),
        params: {},
      } as never)) as { settings: { lookbackDays: number; autoRun: boolean } }
    ).settings;
  const stored = (id: string) =>
    sqlite
      .prepare("SELECT audit_lookback_days AS d, audit_auto_run AS a FROM accounts WHERE id = ?")
      .get(id);

  it("the loader reads this account's settings, NULL as 90 days and off", async () => {
    sqlite
      .prepare("UPDATE accounts SET audit_lookback_days = 30, audit_auto_run = 1 WHERE id = ?")
      .run(ACCOUNT_B);
    expect(await loadSettings(ACCOUNT_A)).toEqual({ lookbackDays: 90, autoRun: false });
    expect(await loadSettings(ACCOUNT_B)).toEqual({ lookbackDays: 30, autoRun: true });
  });

  it("the action writes the caller's account and no other", async () => {
    const res = await callAction(ACCOUNT_A, { audit_lookback_days: "180", audit_auto_run: "true" });
    expect(res.init?.status ?? 200).toBe(200);
    expect(res.data).toMatchObject({ ok: true, lookbackDays: 180, autoRun: true });
    expect(stored(ACCOUNT_A)).toEqual({ d: 180, a: 1 });
    expect(stored(ACCOUNT_B)).toEqual({ d: null, a: null });
  });

  it("a failed write returns 500 with ok false and logs the whole error", async () => {
    const boom = new Error("D1 is down");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const realDb = harness.db;
    harness.db = new Proxy(realDb as object, {
      get(target, prop, receiver) {
        if (prop === "update" || prop === "batch") throw boom;
        return Reflect.get(target, prop, receiver);
      },
    });
    try {
      const res = await callAction(ACCOUNT_A, { audit_lookback_days: "60" });
      expect(res.init?.status).toBe(500);
      expect(res.data).toEqual({ ok: false });
      expect(spy).toHaveBeenCalledWith(expect.any(String), boom);
    } finally {
      harness.db = realDb;
      spy.mockRestore();
    }
  });
});
