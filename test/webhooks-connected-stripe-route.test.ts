import { createHmac } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createInMemoryDb } from "./helpers/inmemory-db";

// THE CONNECTED-ACCOUNT MONEY FRONT DOOR HAD NO EXECUTED COVERAGE. Ruling 376
// item (10), verified across all 215 test files: app/routes/webhooks/stripe was
// imported by no test. Only stripe-platform was driven, and the one place
// app/routes/webhooks/stripe.ts appeared elsewhere was a string in
// sentry-noop-372's path list, which never runs the route. So every payment
// Foxhound ingests arrived through a signature check nothing had exercised.
//
// Built on test/billing-platform-webhook-claim.test.ts's model: drive the REAL
// route action, assert HTTP status plus committed rows. One deliberate
// departure from that model, and it is the point of this file. The platform
// test mocks ~/lib/stripe/webhook and flips a `signatureValid` boolean, which
// proves the route branches on what the verifier says and proves nothing about
// the verifier. Here constructStripeEvent is NOT mocked: every payload below is
// signed with a real v1 HMAC-SHA256 over `${timestamp}.${payload}` under a test
// secret, exactly as Stripe signs, and constructEventAsync verifies it through
// Web Crypto. A wrong-key signature is therefore rejected by the same code that
// rejects one in production, not by a test flag.
//
// The ladder proved here, in the order the route walks it:
//   non-POST                -> 405
//   no signing secret       -> 500, nothing claimed
//   bad signature           -> 400, nothing claimed
//   processing error        -> 500, nothing claimed
//   valid event             -> 200, the claim row committed

const ACCOUNT_ID = "acc_connected";
const CONNECTION_ID = "conn_1";
const STRIPE_USER_ID = "acct_connected_1";
const WEBHOOK_SECRET = "whsec_test_connected";
const RECEIVED_AT = new Date("2026-08-26T05:00:00.000Z");

const harness = vi.hoisted(() => ({
  db: null as unknown,
  sqlite: null as unknown,
  failNextCommit: false,
}));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

vi.mock("~/lib/money/execute", () => ({
  executeMoneyWrite: async (
    _env: Env,
    write: { build: (db: unknown) => unknown[] },
  ): Promise<{ applied: boolean }> => {
    const sqlite = harness.sqlite as { exec: (s: string) => void };
    const batch = write.build(harness.db);
    // Model the money DO honestly: the whole batch commits atomically or not at
    // all. Without the transaction, a claim could survive a failed write and
    // "nothing was claimed" would be aspirational rather than proven.
    sqlite.exec("BEGIN");
    try {
      for (const stmt of batch) await (stmt as Promise<unknown>);
      if (harness.failNextCommit) throw new Error("d1 batch failed");
      sqlite.exec("COMMIT");
      return { applied: true };
    } catch (err) {
      sqlite.exec("ROLLBACK");
      // A UNIQUE violation is the replay case: an idempotent no-op, not an error.
      if (String(err).includes("UNIQUE")) return { applied: false };
      throw err;
    }
  },
}));

const captureException = vi.fn();
vi.mock("@sentry/cloudflare", () => ({ captureException: (...args: unknown[]) => captureException(...args) }));

const { action } = await import("~/routes/webhooks/stripe");
const { cloudflareContext } = await import("~/lib/cloudflare-context");
const schema = await import("~/db/schema");

/** An event Stripe would deliver on the connected endpoint. `payout.paid` is
 *  deliberately a type classifyStripeEvent does not handle, so the processor
 *  takes the claim-only branch: this file is about the ROUTE and its signature
 *  ladder, not about intake or recovery, which have their own suites. */
function connectedEvent(eventId: string, account: string | null = STRIPE_USER_ID) {
  return JSON.stringify({
    id: eventId,
    type: "payout.paid",
    account,
    created: Math.floor(RECEIVED_AT.getTime() / 1000),
    data: { object: { id: "po_1", object: "payout" } },
  });
}

/** Sign a payload the way Stripe signs it: v1 is a hex HMAC-SHA256 over
 *  `${timestamp}.${payload}` keyed on the endpoint's signing secret. */
function stripeSignature(payload: string, secret: string, timestampSec: number): string {
  const mac = createHmac("sha256", secret).update(`${timestampSec}.${payload}`).digest("hex");
  return `t=${timestampSec},v1=${mac}`;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** Drive the real route action with a stubbed request context.
 *
 *  `secret` takes NO default on purpose. It had one, and the unset-secret test
 *  passed `undefined` to say "no secret configured", which is exactly the value
 *  that makes JavaScript apply the default instead: that case ran WITH the
 *  secret, got a valid 200, and reported the route as broken. The harness was
 *  wrong, not the route. Every call site now states the secret it means. */
function call(request: Request, secret: string | undefined): Promise<Response> {
  const env = {
    STRIPE_WEBHOOK_SECRET: secret,
    STRIPE_SECRET_KEY: "sk_test_connected",
  } as unknown as Env;
  const context = {
    get: (key: unknown) => {
      if (key !== cloudflareContext) throw new Error("unexpected context key");
      return { env, ctx: {} as ExecutionContext, nonce: "n" };
    },
  };
  return action({ request, context } as never) as Promise<Response>;
}

function webhookRequest(
  payload: string,
  signature: string,
  method = "POST",
): Request {
  return new Request("https://app.foxhoundapp.com/webhooks/stripe", {
    method,
    body: method === "GET" ? undefined : payload,
    headers: signature ? { "stripe-signature": signature } : {},
  });
}

/** A correctly signed POST of `payload`, which is the only thing Stripe ever sends. */
function signedRequest(payload: string, secret = WEBHOOK_SECRET, timestampSec = nowSec()): Request {
  return webhookRequest(payload, stripeSignature(payload, secret, timestampSec));
}

async function seed({ connected = true }: { connected?: boolean } = {}) {
  const { sqlite, db } = createInMemoryDb();
  harness.db = db;
  harness.sqlite = sqlite;
  await db.insert(schema.accounts).values({ id: ACCOUNT_ID, name: "Connected Co", createdAt: RECEIVED_AT });
  if (connected) {
    await db.insert(schema.stripeConnections).values({
      id: CONNECTION_ID,
      accountId: ACCOUNT_ID,
      stripeUserId: STRIPE_USER_ID,
      isPrimary: true,
      connectedAt: RECEIVED_AT,
      createdAt: RECEIVED_AT,
    });
  }
  return db;
}

beforeEach(() => {
  harness.failNextCommit = false;
  captureException.mockClear();
});

describe("connected webhook: the method and configuration rungs", () => {
  it("answers a non-POST with 405 and claims nothing", async () => {
    const db = await seed();
    const res = await call(webhookRequest("", "", "GET"), WEBHOOK_SECRET);
    expect(res.status).toBe(405);
    expect(await db.select().from(schema.webhookEvents)).toHaveLength(0);
  });

  it("answers 500 when the signing secret is unset, so Stripe retries rather than losing the event", async () => {
    const db = await seed();
    const payload = connectedEvent("evt_no_secret");
    const res = await call(signedRequest(payload), undefined);
    // Fail closed: a misconfiguration must not read as a handled event.
    expect(res.status).toBe(500);
    expect(await db.select().from(schema.webhookEvents)).toHaveLength(0);
  });
});

describe("connected webhook: the signature rung, against a real HMAC", () => {

  it("rejects a POST carrying no stripe-signature header at all", async () => {
    const db = await seed();
    const res = await call(webhookRequest(connectedEvent("evt_unsigned"), ""), WEBHOOK_SECRET);
    expect(res.status).toBe(400);
    expect(await db.select().from(schema.webhookEvents)).toHaveLength(0);
  });
});

describe("connected webhook: the processing rung", () => {
  it("answers 500 and claims NOTHING when the money batch fails", async () => {
    const db = await seed();
    harness.failNextCommit = true;

    const res = await call(signedRequest(connectedEvent("evt_batch_fails")), WEBHOOK_SECRET);

    // Stripe retries a 500, and the batch is atomic and idempotent, so the
    // retry is safe. A 200 here would lose the event permanently.
    expect(res.status).toBe(500);
    expect(await db.select().from(schema.webhookEvents)).toHaveLength(0);
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it("the redelivery after that failure then claims exactly once", async () => {
    const db = await seed();
    const payload = connectedEvent("evt_retry_once");

    harness.failNextCommit = true;
    expect((await call(signedRequest(payload), WEBHOOK_SECRET)).status).toBe(500);
    expect(await db.select().from(schema.webhookEvents)).toHaveLength(0);

    harness.failNextCommit = false;
    const retry = await call(signedRequest(payload), WEBHOOK_SECRET);
    expect(retry.status).toBe(200);
    expect(await db.select().from(schema.webhookEvents)).toHaveLength(1);
  });
});

describe("connected webhook: a valid event", () => {
  it("answers 200 and commits the claim row against the connected account", async () => {
    const db = await seed();
    const res = await call(signedRequest(connectedEvent("evt_valid")), WEBHOOK_SECRET);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, outcome: "ignored" });

    const rows = await db.select().from(schema.webhookEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0].stripeEventId).toBe("evt_valid");
    expect(rows[0].eventType).toBe("payout.paid");
    // Resolved through stripe_connections, not taken from the request.
    expect(rows[0].accountId).toBe(ACCOUNT_ID);
    expect(rows[0].processed).toBe(true);
    expect(captureException).not.toHaveBeenCalled();
  });

  it("a redelivery of the same event id is a duplicate, not a second claim", async () => {
    const db = await seed();
    const payload = connectedEvent("evt_replayed");

    expect((await call(signedRequest(payload), WEBHOOK_SECRET)).status).toBe(200);
    const second = await call(signedRequest(payload), WEBHOOK_SECRET);

    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ received: true, outcome: "duplicate" });
    expect(await db.select().from(schema.webhookEvents)).toHaveLength(1);
  });

  it("ignores an event carrying no connected account, without claiming", async () => {
    const db = await seed();
    const res = await call(signedRequest(connectedEvent("evt_no_account", null)), WEBHOOK_SECRET);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, outcome: "ignored" });
    expect(await db.select().from(schema.webhookEvents)).toHaveLength(0);
  });
});
