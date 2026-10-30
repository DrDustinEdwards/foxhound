import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cloudflareContext } from "~/lib/cloudflare-context";

import { createInMemoryDb } from "./helpers/inmemory-db";

// SESSION 51 / 343 binding 4: /p/:token gains a RESUBSCRIBE MODE.
//
// Legacy's win-back email links to a Stripe billing portal session created at
// SEND time, once per step, on the merchant's account. Foxhound creates nothing
// at send time: the email carries a signed token and the Stripe object is
// created only on a real click.
//
// THE LOAD-BEARING ASSERTIONS are that the click creates exactly ONE Checkout
// Session, on the CONNECTED account, carrying the metadata session 52 matches
// on, and that Foxhound itself never creates a subscription and never records
// an outcome. `winback_reactivated` belongs to the completion, which session 52
// owns; a click is not a reactivation.

const harness = vi.hoisted(() => ({
  db: null as unknown,
  connectedTokens: [] as string[],
  platformClientCalls: 0,
  sessionsCreated: [] as Record<string, unknown>[],
  subscriptionsRetrieved: [] as string[],
  subscriptionsCreated: 0,
  subscription: null as unknown,
}));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

vi.mock("~/lib/stripe/encryption", () => ({
  decryptToken: async (_env: unknown, cipher: string) => `plain:${cipher}`,
}));

// The REAL service runs against a stubbed SDK, so the plants read the exact
// arguments that would go to Stripe rather than a hand-built copy of them.
vi.mock("~/lib/stripe/client", () => {
  const stripe = {
    checkout: {
      sessions: {
        create: async (params: Record<string, unknown>) => {
          harness.sessionsCreated.push(params);
          return { url: "https://checkout.stripe.test/c/pay/cs_1" };
        },
      },
    },
    subscriptions: {
      retrieve: async (id: string) => {
        harness.subscriptionsRetrieved.push(id);
        if (!harness.subscription) throw new Error("no such subscription");
        return harness.subscription;
      },
      create: async () => {
        harness.subscriptionsCreated += 1;
        return {};
      },
    },
  };
  return {
    getConnectedStripe: (accessToken: string) => {
      harness.connectedTokens.push(accessToken);
      return stripe;
    },
    getStripe: () => {
      harness.platformClientCalls += 1;
      return stripe;
    },
  };
});

const { loader, action } = await import("~/routes/utility/card-update");
const { signCardUpdateToken, verifyCardUpdateToken } = await import("~/lib/card-update/token");
const { CARD_UPDATE_TOKEN_MAX_AGE_MS } = await import("~/lib/constants");

const ACCOUNT = "acct_1";
const ENV = { ENCRYPTION_KEY: "ab".repeat(32) } as unknown as Env;

let sqlite: Database.Database;
let db: ReturnType<typeof createInMemoryDb>["db"];

const ctx = {
  get(key: unknown) {
    if (key === cloudflareContext) return { env: ENV, ctx: {} as ExecutionContext, nonce: "n" };
    throw new Error("unexpected context key");
  },
} as unknown as Parameters<typeof loader>[0]["context"];

beforeEach(() => {
  ({ sqlite, db } = createInMemoryDb());
  harness.db = db;
  harness.connectedTokens = [];
  harness.platformClientCalls = 0;
  harness.sessionsCreated = [];
  harness.subscriptionsRetrieved = [];
  harness.subscriptionsCreated = 0;
  harness.subscription = {
    items: { data: [{ price: { id: "price_pro" }, quantity: 3 }] },
  };
  seedAccount(ACCOUNT);
});

function seedAccount(accountId: string, connectionId = "c1"): void {
  sqlite.prepare("INSERT INTO accounts (id, name, created_at) VALUES (?, 'Acme', 1000)").run(accountId);
  sqlite
      // ONE LIVE CONNECTION PER STRIPE ACCOUNT. The Stripe account id is
      // derived from the Foxhound account rather than hardcoded, because a
      // shared literal made every two-account fixture violate the unique
      // index the moment it shipped, and production could never have had two
      // merchants on one connected account anyway.
    .prepare(
      "INSERT INTO stripe_connections (id, account_id, stripe_user_id, is_primary, stripe_access_token, connected_at, created_at) VALUES (?, ?, ?, 1, 'cipher', 1000, 1000)",
    )
    .run(connectionId, accountId, `acct_s_${accountId}`);
}

function seedSequence(
  opts: { id?: string; status?: string; accountId?: string; connectionId?: string | null; planName?: string | null } = {},
): string {
  const id = opts.id ?? "wb_1";
  sqlite
    .prepare(
      "INSERT INTO win_back_sequences (id, account_id, stripe_customer_id, stripe_subscription_id, customer_email, customer_name, plan_name, amount_cents, currency, status, created_at, stripe_connection_id) VALUES (?, ?, 'cus_wb', 'sub_dead', 'buyer@acme.test', 'Jane', ?, 4900, 'usd', ?, 1000, ?)",
    )
    .run(
      id,
      opts.accountId ?? ACCOUNT,
      opts.planName === undefined ? "Pro" : opts.planName,
      opts.status ?? "active",
      opts.connectionId === undefined ? "c1" : opts.connectionId,
    );
  return id;
}

async function resubscribeToken(
  opts: { sequenceId?: string; accountId?: string; stepNumber?: number } = {},
): Promise<string> {
  return signCardUpdateToken(ENV, {
    winBackSequenceId: opts.sequenceId ?? "wb_1",
    winBackStepNumber: opts.stepNumber ?? 2,
    accountId: opts.accountId ?? ACCOUNT,
  });
}

async function load(token: string, search = ""): Promise<Record<string, unknown>> {
  const res = (await loader({
    context: ctx,
    request: new Request(`https://foxhoundapp.test/p/${token}${search}`),
    params: { token },
  } as never)) as unknown as { data: Record<string, unknown> };
  return res.data;
}

async function post(token: string): Promise<Response> {
  return (await action({
    context: ctx,
    request: new Request(`https://foxhoundapp.test/p/${token}`, { method: "POST" }),
    params: { token },
  } as never)) as unknown as Response;
}

function outcomeRows() {
  return sqlite.prepare("SELECT id, event_type AS eventType FROM outcomes").all();
}

describe("PLANT 1: the resubscribe token round-trips, and a stale one does not", () => {

  it("AN EXPIRED TOKEN REFUSES, so a win-back link does not work forever", async () => {
    const issued = Date.now() - CARD_UPDATE_TOKEN_MAX_AGE_MS - 1000;
    const spy = vi.spyOn(Date, "now").mockReturnValue(issued);
    const token = await resubscribeToken();
    spy.mockRestore();

    expect(await verifyCardUpdateToken(ENV, token)).toBeNull();
    expect(await load(token)).toEqual({ state: "invalid" });
  });

  it("A SEQUENCE ID WITH NO STEP NUMBER REFUSES, so no session can be minted unattributed", async () => {
    const token = await signCardUpdateToken(ENV, {
      winBackSequenceId: "wb_1",
      accountId: ACCOUNT,
    });
    expect(await verifyCardUpdateToken(ENV, token)).toBeNull();
  });

  it("A TOKEN CARRYING TWO TARGETS REFUSES, rather than letting dispatch order pick", async () => {
    const token = await signCardUpdateToken(ENV, {
      winBackSequenceId: "wb_1",
      winBackStepNumber: 1,
      failedPaymentId: "fp_1",
      accountId: ACCOUNT,
    });
    expect(await verifyCardUpdateToken(ENV, token)).toBeNull();
  });
});

describe("PLANT 2: the page renders one button and calls no Stripe", () => {

  it("a sequence with no plan name still renders, with no subtitle to build", async () => {
    seedSequence({ planName: null });

    expect(await load(await resubscribeToken())).toEqual({ state: "resubscribe", planName: null });
  });

  it("AND STAYS INVALID WHEN EVERY OTHER LAYER IS SATISFIED", async () => {
    // Reaching the sequence lookup's account scope ALONE.
    // THREE layers refuse a cross-account read: the sequence query's own
    // account filter, the connection query's account filter, and
    // resolveConnectionForFailedPayment's pin on the sequence's recorded
    // connection id. The other two are satisfied deliberately here, by giving
    // the foreign account a live connection AND pointing the sequence at it,
    // so only the first layer can refuse. That row shape is unreachable in
    // production, which is the point: a layer proven only in company is not
    // proven.
    seedAccount("acct_other", "c_other");
    seedSequence({ connectionId: "c_other" });
    const token = await resubscribeToken({ accountId: "acct_other" });

    expect(await load(token)).toEqual({ state: "invalid" });
    expect(JSON.stringify(await post(token))).toContain("no longer active");
    expect(harness.sessionsCreated).toEqual([]);
  });

  it("a sequence whose connection is gone is invalid, never a dead button", async () => {
    seedSequence({ connectionId: null });
    sqlite.prepare("UPDATE stripe_connections SET disconnected_at = 2000 WHERE id = 'c1'").run();
    expect(await load(await resubscribeToken())).toEqual({ state: "invalid" });
  });

  it("the Stripe return renders the restarted state and writes nothing", async () => {
    seedSequence();

    expect(await load(await resubscribeToken(), "?done=1")).toEqual({ state: "resubscribed" });
    expect(outcomeRows()).toEqual([]);
    expect(
      sqlite.prepare("SELECT status, reactivated_at AS at FROM win_back_sequences").all(),
    ).toEqual([{ status: "active", at: null }]);
  });
});

describe("PLANT 3: the click creates exactly one Checkout Session", () => {
  it("on the connected account, with the stored price, the customer and the metadata", async () => {
    seedSequence();
    const token = await resubscribeToken({ stepNumber: 3 });

    const res = await post(token);

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://checkout.stripe.test/c/pay/cs_1");

    // EXACTLY ONE session.
    expect(harness.sessionsCreated).toHaveLength(1);
    const params = harness.sessionsCreated[0];
    expect(params.mode).toBe("subscription");
    expect(params.customer).toBe("cus_wb");
    // The price is re-read off the CANCELLED subscription, because neither
    // side stores a price id.
    expect(harness.subscriptionsRetrieved).toEqual(["sub_dead"]);
    expect(params.line_items).toEqual([{ price: "price_pro", quantity: 3 }]);
    // THE METADATA SESSION 52 MATCHES ON, on the session and on the
    // subscription it creates.
    expect(params.metadata).toEqual({ win_back_sequence_id: "wb_1", win_back_step_number: "3" });
    expect(params.subscription_data).toEqual({
      metadata: { win_back_sequence_id: "wb_1", win_back_step_number: "3" },
    });
    expect(params.success_url).toBe(`https://foxhoundapp.test/p/${token}?done=1`);
    expect(params.cancel_url).toBe(`https://foxhoundapp.test/p/${token}`);

    // THE CONNECTED ACCOUNT, never the platform key. Standard Connect's OAuth
    // access token is a full API key for that account, so there is no
    // stripeAccount header to assert; the token IS the account.
    //
    // EVERY client in the flow is asserted, not just one of them: `toContain`
    // stayed green under a mutation that dropped the merchant's token from the
    // subscription read while the Checkout call still carried it.
    expect(harness.connectedTokens).toEqual(["plain:cipher", "plain:cipher"]);
    expect(harness.platformClientCalls).toBe(0);
  });

  it("FOXHOUND CREATES NO SUBSCRIPTION ITSELF; Stripe hosts that", async () => {
    seedSequence();

    await post(await resubscribeToken());

    expect(harness.subscriptionsCreated).toBe(0);
  });

  it("RECORDS NO OUTCOME: a click is not a reactivation, and 52 owns the completion", async () => {
    seedSequence();

    await post(await resubscribeToken());

    expect(outcomeRows()).toEqual([]);
    expect(
      sqlite.prepare("SELECT status, reactivated_at AS at FROM win_back_sequences").all(),
    ).toEqual([{ status: "active", at: null }]);
  });

  it("a subscription whose price cannot be read refuses, and creates no session", async () => {
    seedSequence();
    harness.subscription = { items: { data: [] } };

    const res = (await post(await resubscribeToken())) as unknown as { data: { error: string }; init?: { status: number } };

    expect(harness.sessionsCreated).toEqual([]);
    expect(JSON.stringify(res)).toContain("no longer available");
  });

  it("a subscription Stripe cannot return is a clean refusal, never a stack trace", async () => {
    seedSequence();
    harness.subscription = null;

    const res = await post(await resubscribeToken());

    expect(harness.sessionsCreated).toEqual([]);
    expect(JSON.stringify(res)).toContain("Could not start the reactivation");
  });
});

describe("PLANT 4: the sequences that must NOT reach Stripe", () => {
  it("a REACTIVATED sequence renders already-handled and creates no session", async () => {
    seedSequence({ status: "reactivated" });
    const token = await resubscribeToken();

    expect(await load(token)).toEqual({ state: "handled" });
    await post(token);
    expect(harness.sessionsCreated).toEqual([]);
  });

  it("a RESOLVED sequence renders already-handled and creates no session", async () => {
    seedSequence({ status: "resolved" });
    const token = await resubscribeToken();

    expect(await load(token)).toEqual({ state: "handled" });
    await post(token);
    expect(harness.sessionsCreated).toEqual([]);
  });

  it("A DEMO ACCOUNT REFUSES AT THE STRIPE-CALL GATE", async () => {
    seedAccount("demo_teamflow", "c_demo");
    seedSequence({ id: "wb_demo", accountId: "demo_teamflow", connectionId: "c_demo" });
    const token = await resubscribeToken({ sequenceId: "wb_demo", accountId: "demo_teamflow" });

    const res = await post(token);

    expect(harness.sessionsCreated).toEqual([]);
    expect(harness.subscriptionsRetrieved).toEqual([]);
    expect(JSON.stringify(res)).toContain("demo account");
  });
});
