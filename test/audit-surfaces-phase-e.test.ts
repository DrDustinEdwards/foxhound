
import type Database from "better-sqlite3";
import type Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { runAudit, type AuditInputs, type ScopeOutcome } from "~/lib/audit/engine";
import { toStoredAuditRun } from "~/lib/audit/render";
import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";

import { createInMemoryDb } from "./helpers/inmemory-db";

// SESSION 70, PHASE (e): the two authenticated audit surfaces.
//
// THE PROPERTY THESE PLANTS EXIST FOR is the one that has now survived four
// hand-offs: a scope that could not be read must never render as a zero. The
// engine gave it a status (362 ruling 2), persistence stored it as NULL (364),
// and this is the layer where legacy loses it: its stored-run page maps every
// column with `?? 0`.
//
// PLANTS DRIVE THE REAL LOADERS (352), with two accounts in every fixture.

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
        return { env: {} as Env, ctx: {} as ExecutionContext, nonce: "n" };
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
      failedInvoicesCents: number | null;
      openDisputesCents: number | null;
      mrrCents: number | null;
    }[];
  }>;

const loadRun = (accountId: string, id: string) =>
  runPage.loader({
    context: contextFor(accountId),
    request: new Request("https://foxhoundapp.test/audit/runs/x"),
    params: { id },
  } as never);

describe("PLANT 1: the history surface", () => {

  it("carries a NULL through to the loader rather than coalescing it", async () => {
    await save(ACCOUNT_A, auditWith({ subscriptions: failedRead("subs unavailable") }));
    const { runs } = await loadHistory(ACCOUNT_A);
    // MRR comes from the subscriptions read, so it is null, not 0.
    expect(runs[0].failedInvoicesCents).toBe(0);
    expect(runs[0].mrrCents).toBeNull();
  });
});

describe("PLANT 2: the stored-run surface", () => {
  it("reads one run and maps every scope", async () => {
    const id = await save(
      ACCOUNT_A,
      auditWith({
        uncollectibleInvoices: ok<Stripe.Invoice>([
          invoice({ amount_due: 25_000, last_finalization_error: { decline_code: "expired_card" } }),
        ]),
        disputes: ok<Stripe.Dispute>([dispute({ status: "needs_response", amount: 9_000 })]),
      }),
    );
    const { run } = (await loadRun(ACCOUNT_A, id)) as { run: ReturnType<typeof toStoredAuditRun> };
    expect(run.failedInvoices).toMatchObject({ count: 1, totalCents: 25_000 });
    expect(run.failedInvoices!.byCategory.expired).toBe(25_000);
    expect(run.disputes!.open).toEqual({ count: 1, totalCents: 9_000 });
    expect(run.health!.mrrCents).toBe(0);
    expect(run.summary).toBe("One. Two. Three.");
  });

  it("A SCOPE THAT COULD NOT BE READ ARRIVES AS null, never as a zero", async () => {
    // Legacy's own mapper is `row.open_disputes_count ?? 0`, which is exactly
    // the flattening 362 ruling 2 exists to stop. This is where it would happen.
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
    expect(run.failedInvoices).toMatchObject({ count: 0, totalCents: 0 });
  });

  it("404s on an id that does not exist at all", async () => {
    await expect(loadRun(ACCOUNT_A, "nope")).rejects.toMatchObject({ status: 404 });
  });
});

describe("PLANT 3: the Card Updater's two nulls stay apart", () => {
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
