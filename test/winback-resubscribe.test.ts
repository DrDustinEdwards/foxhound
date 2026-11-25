import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cloudflareContext } from "@dustinedwards/site-runtime/context";

import { createInMemoryDb } from "./helpers/inmemory-db";

// /p/:token resubscribe mode: a click creates exactly one Checkout Session on the connected account with
// the win-back metadata, and records no outcome (the completion does).

const harness = vi.hoisted(() => ({
  db: null as unknown,
  connectedTokens: [] as string[],
  platformClientCalls: 0,
  sessionsCreated: [] as Record<string, unknown>[],
  subscriptionsRetrieved: [] as string[],
  subscription: null as unknown,
}));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

vi.mock("~/lib/stripe/encryption", () => ({
  decryptToken: async (_env: unknown, cipher: string) => `plain:${cipher}`,
}));

// The real service runs against a stubbed SDK, so the exact arguments to Stripe are read.
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
    if (key === cloudflareContext) return { env: ENV, ctx: {} as ExecutionContext };
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
  harness.subscription = {
    items: { data: [{ price: { id: "price_pro" }, quantity: 3 }] },
  };
  seedAccount(ACCOUNT);
});

function seedAccount(accountId: string, connectionId = "c1"): void {
  sqlite
    .prepare("INSERT INTO accounts (id, name, created_at) VALUES (?, 'Acme', 1000)")
    .run(accountId);
  sqlite
    // One live connection per Stripe account, so the id derives from the account.
    .prepare(
      "INSERT INTO stripe_connections (id, account_id, stripe_user_id, is_primary, stripe_access_token, connected_at, created_at) VALUES (?, ?, ?, 1, 'cipher', 1000, 1000)",
    )
    .run(connectionId, accountId, `acct_s_${accountId}`);
}

function seedSequence(
  opts: {
    id?: string;
    status?: string;
    accountId?: string;
    connectionId?: string | null;
    planName?: string | null;
  } = {},
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

describe("the resubscribe token", () => {
  it("an expired token refuses", async () => {
    const issued = Date.now() - CARD_UPDATE_TOKEN_MAX_AGE_MS - 1000;
    const spy = vi.spyOn(Date, "now").mockReturnValue(issued);
    const token = await resubscribeToken();
    spy.mockRestore();

    expect(await verifyCardUpdateToken(ENV, token)).toBeNull();
    expect(await load(token)).toEqual({ state: "invalid" });
  });

  it("a sequence id with no step number refuses", async () => {
    const token = await signCardUpdateToken(ENV, {
      winBackSequenceId: "wb_1",
      accountId: ACCOUNT,
    });
    expect(await verifyCardUpdateToken(ENV, token)).toBeNull();
  });

  it("a token carrying two targets refuses", async () => {
    const token = await signCardUpdateToken(ENV, {
      winBackSequenceId: "wb_1",
      winBackStepNumber: 1,
      failedPaymentId: "fp_1",
      accountId: ACCOUNT,
    });
    expect(await verifyCardUpdateToken(ENV, token)).toBeNull();
  });
});

describe("the page", () => {
  it("another account's token stays invalid even when the other layers are satisfied", async () => {
    // Another account's live connection, with the sequence pointed at it, leaves only the sequence
    // query's own account filter to refuse.
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
});

describe("the click creates exactly one Checkout Session", () => {
  it("on the connected account, with the stored price, the customer and the metadata", async () => {
    seedSequence();
    const token = await resubscribeToken({ stepNumber: 3 });

    const res = await post(token);

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://checkout.stripe.test/c/pay/cs_1");

    expect(harness.sessionsCreated).toHaveLength(1);
    const params = harness.sessionsCreated[0];
    expect(params.mode).toBe("subscription");
    expect(params.customer).toBe("cus_wb");
    expect(harness.subscriptionsRetrieved).toEqual(["sub_dead"]);
    expect(params.line_items).toEqual([{ price: "price_pro", quantity: 3 }]);
    expect(params.metadata).toEqual({ win_back_sequence_id: "wb_1", win_back_step_number: "3" });
    expect(params.subscription_data).toEqual({
      metadata: { win_back_sequence_id: "wb_1", win_back_step_number: "3" },
    });
    expect(params.success_url).toBe(`https://foxhoundapp.test/p/${token}?done=1`);
    expect(params.cancel_url).toBe(`https://foxhoundapp.test/p/${token}`);

    // Every client in the flow uses the merchant's token, never the platform key.
    expect(harness.connectedTokens).toEqual(["plain:cipher", "plain:cipher"]);
    expect(harness.platformClientCalls).toBe(0);
  });

  it("records no outcome: a click is not a reactivation", async () => {
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

    const res = (await post(await resubscribeToken())) as unknown as {
      data: { error: string };
      init?: { status: number };
    };

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

describe("sequences that must not reach Stripe", () => {
  it.each(["reactivated", "resolved"])(
    "a %s sequence renders already-handled and creates no session",
    async (status) => {
      seedSequence({ status });
      const token = await resubscribeToken();

      expect(await load(token)).toEqual({ state: "handled" });
      await post(token);
      expect(harness.sessionsCreated).toEqual([]);
    },
  );

  it("a demo account refuses at the Stripe-call gate", async () => {
    seedAccount("demo_teamflow", "c_demo");
    seedSequence({ id: "wb_demo", accountId: "demo_teamflow", connectionId: "c_demo" });
    const token = await resubscribeToken({ sequenceId: "wb_demo", accountId: "demo_teamflow" });

    const res = await post(token);

    expect(harness.sessionsCreated).toEqual([]);
    expect(harness.subscriptionsRetrieved).toEqual([]);
    expect(JSON.stringify(res)).toContain("demo account");
  });
});
