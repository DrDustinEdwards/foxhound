import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Ruling 400 halt ruling 1, the surface half: what the merchant can reach, and
// what a caller pointed at somebody else's dispute gets back.
//
// ACCOUNT SCOPING HERE IS THE TOKEN, not a filter. The connected account's
// OAuth access token is an API key for that account, so a dispute id belonging
// to another Stripe account is simply not retrievable and never reaches a
// write. That is what the "foreign id" case below exercises: Stripe answers
// not-found, and the assertion that matters is that executeMoneyWrite was not
// called at all. An assertion that only checked the returned status would pass
// even if the code had written first and reported second.

const executeMoneyWrite = vi.fn();
const disputesRetrieve = vi.fn();
const resolveDisputedRecovery = vi.fn();

vi.mock("~/lib/money/execute", () => ({
  executeMoneyWrite: (...args: unknown[]) => executeMoneyWrite(...args),
}));
vi.mock("~/lib/stripe/client", () => ({
  getConnectedStripe: () => ({ disputes: { retrieve: disputesRetrieve } }),
}));
vi.mock("~/lib/stripe/encryption", () => ({
  decryptToken: async () => "sk_test_connected",
}));
vi.mock("~/lib/webhooks/process", () => ({
  resolveDisputedRecovery: (...args: unknown[]) => resolveDisputedRecovery(...args),
}));

const { accounts, stripeConnections } = await import("~/db");
const { importDisputeFromStripe, manualImportClaimKey } = await import(
  "~/lib/disputes/manual-import.server"
);
const DisputesRoute = (await import("~/routes/app/disputes/index")).default;
const { createInMemoryDb } = await import("./helpers/inmemory-db");

const NOW = new Date("2026-08-30T00:00:00.000Z");
const ACCOUNT = "acct_manual";

async function envWithConnection(connected: boolean): Promise<Env> {
  const { db, sqlite } = createInMemoryDb();
  await db.insert(accounts).values({ id: ACCOUNT, name: "Manual Co", createdAt: NOW });
  if (connected) {
    await db.insert(stripeConnections).values({
      id: "conn_1",
      accountId: ACCOUNT,
      stripeUserId: "acct_stripe_manual",
      stripeAccessToken: "encrypted",
      connectedAt: NOW,
      createdAt: NOW,
    });
  }
  // getDb(env) reads env.DB; the in-memory handle stands in for the D1 binding
  // through the same drizzle surface the module uses.
  void sqlite;
  return { DB: db } as unknown as Env;
}

// getDb is the one thing that has to yield our fixture rather than a real D1.
vi.mock("~/db", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, getDb: (env: { DB: unknown }) => env.DB };
});

beforeEach(() => {
  executeMoneyWrite.mockReset();
  disputesRetrieve.mockReset();
  resolveDisputedRecovery.mockReset();
  resolveDisputedRecovery.mockResolvedValue(null);
  executeMoneyWrite.mockResolvedValue({ applied: true });
});

describe("importDisputeFromStripe", () => {
  it("imports a dispute on this account and keys the write on the dispute id", async () => {
    // The positive control (383): without one, every "did not write" assertion
    // below would be green on a function that never writes at all.
    const env = await envWithConnection(true);
    disputesRetrieve.mockResolvedValue({
      id: "dp_mine",
      charge: "ch_1",
      payment_intent: "pi_1",
      amount: 4_500,
      currency: "usd",
      reason: "fraudulent",
      status: "needs_response",
      created: 1_700_000_000,
    });

    const result = await importDisputeFromStripe(env, ACCOUNT, "dp_mine", NOW);

    expect(result).toEqual({ status: "imported", disputeId: expect.any(String) });
    expect(executeMoneyWrite).toHaveBeenCalledTimes(1);
    const write = executeMoneyWrite.mock.calls[0][1] as { accountId: string; idempotencyKey: string };
    expect(write.accountId).toBe(ACCOUNT);
    expect(write.idempotencyKey).toBe(manualImportClaimKey("dp_mine"));
  });

  it("reports already_imported rather than an error when the write is a no-op", async () => {
    const env = await envWithConnection(true);
    disputesRetrieve.mockResolvedValue({
      id: "dp_mine",
      charge: "ch_1",
      amount: 1,
      currency: "usd",
      reason: "general",
      status: "needs_response",
      created: 1,
    });
    executeMoneyWrite.mockResolvedValue({ applied: false });

    expect(await importDisputeFromStripe(env, ACCOUNT, "dp_mine", NOW)).toEqual({
      status: "already_imported",
    });
  });

  it("404s on another account's dispute id and writes nothing", async () => {
    // The connected token cannot see it, so Stripe throws. The point of the
    // second assertion is that nothing was written BEFORE the lookup failed.
    const env = await envWithConnection(true);
    disputesRetrieve.mockRejectedValue(
      Object.assign(new Error("No such dispute: dp_someone_else"), { code: "resource_missing" }),
    );

    expect(await importDisputeFromStripe(env, ACCOUNT, "dp_someone_else", NOW)).toEqual({
      status: "not_found",
    });
    expect(executeMoneyWrite).not.toHaveBeenCalled();
  });

  it("refuses a malformed id before it ever reaches Stripe", async () => {
    const env = await envWithConnection(true);
    expect(await importDisputeFromStripe(env, ACCOUNT, "ch_not_a_dispute", NOW)).toEqual({
      status: "invalid_id",
    });
    expect(disputesRetrieve).not.toHaveBeenCalled();
    expect(executeMoneyWrite).not.toHaveBeenCalled();
  });

  it("refuses when the account has no live Stripe connection", async () => {
    const env = await envWithConnection(false);
    expect(await importDisputeFromStripe(env, ACCOUNT, "dp_mine", NOW)).toEqual({
      status: "not_connected",
    });
    expect(disputesRetrieve).not.toHaveBeenCalled();
    expect(executeMoneyWrite).not.toHaveBeenCalled();
  });

  it("writes nothing for a dispute carrying no charge", async () => {
    const env = await envWithConnection(true);
    disputesRetrieve.mockResolvedValue({ id: "dp_mine", charge: null, amount: 1, currency: "usd" });
    expect(await importDisputeFromStripe(env, ACCOUNT, "dp_mine", NOW)).toEqual({
      status: "not_found",
    });
    expect(executeMoneyWrite).not.toHaveBeenCalled();
  });
});

describe("the Sync dispute control on /disputes", () => {
  const Page = DisputesRoute as unknown as (props: {
    loaderData: Record<string, unknown>;
  }) => ReactElement;

  function render(isDemo: boolean): string {
    const Stub = createRoutesStub([
      {
        path: "/",
        Component: () =>
          createElement(Page, {
            loaderData: {
              disputes: [],
              stats: { openCount: 0, atStake: [], feesOwed: [] },
              health: null,
              nowMs: NOW.getTime(),
              isDemo,
            },
          }),
      },
    ]);
    return renderToStaticMarkup(createElement(Stub));
  }

  it("renders legacy's control for a real merchant, on the empty state too", () => {
    // Legacy renders SyncDisputeLink OUTSIDE DisputesDashboardView's empty
    // branch, so it shows with no disputes. That is the state a merchant
    // importing a pre-connection dispute is most likely looking at, so the
    // empty fixture above is the discriminating one.
    const html = render(false);
    expect(html).toContain("Sync dispute from Stripe");
  });

  it("withholds it entirely from a demo visitor", () => {
    // Legacy's demo twin renders DisputesDashboardView alone and no import
    // control. The middleware's method gate is still the boundary for a
    // hand-crafted POST; this is the surface not offering the action at all.
    expect(render(true)).not.toContain("Sync dispute from Stripe");
  });
});
