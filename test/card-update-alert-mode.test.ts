import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cloudflareContext } from "~/lib/cloudflare-context";

import { createInMemoryDb } from "./helpers/inmemory-db";

// JOB 2b / 341 binding 2: /p/:token gains an ALERT MODE.
//
// An expiring-card alert warns a customer before the card lapses, so there is
// no failed payment to name. The token's failedPaymentId becomes optional and
// the page resolves the customer from the alert row instead.
//
// THE LOAD-BEARING ASSERTION is that alert mode records NO attribution signal:
// buildCardUpdateSignal writes a recovery_steps row that findAttributionSignals
// reads as billable `card_update`, and an alert has no failed payment to
// attribute to.

const harness = vi.hoisted(() => ({
  db: null as unknown,
  sessions: [] as { customerId: string; successUrl: string }[],
  finalized: [] as { sessionId: string; subscriptionId: string | null | undefined }[],
}));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

vi.mock("~/lib/stripe/encryption", () => ({
  decryptToken: async (_env: unknown, cipher: string) => `plain:${cipher}`,
}));

vi.mock("~/lib/card-update/service", () => ({
  createCardUpdateSession: async (input: { customerId: string; successUrl: string }) => {
    harness.sessions.push({ customerId: input.customerId, successUrl: input.successUrl });
    return { url: "https://checkout.stripe.test/s/1" };
  },
  finalizeCardUpdateSession: async (input: { sessionId: string; subscriptionId?: string | null }) => {
    harness.finalized.push({ sessionId: input.sessionId, subscriptionId: input.subscriptionId });
    return { ok: true };
  },
}));

const { loader, action } = await import("~/routes/utility/card-update");
const { signCardUpdateToken } = await import("~/lib/card-update/token");

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
  harness.sessions = [];
  harness.finalized = [];
  sqlite.prepare("INSERT INTO accounts (id, name, created_at) VALUES (?, 'Acme', 1000)").run(ACCOUNT);
  sqlite
    .prepare(
      "INSERT INTO stripe_connections (id, account_id, stripe_user_id, is_primary, stripe_access_token, connected_at, created_at) VALUES ('c1', ?, 'acct_s', 1, 'cipher', 1000, 1000)",
    )
    .run(ACCOUNT);
});

function seedAlert(id = "al_1", opts: { deleted?: boolean; connectionId?: string | null } = {}): void {
  sqlite
    .prepare(
      "INSERT INTO expiring_card_alerts (id, account_id, stripe_customer_id, customer_email, expires_month, expires_year, created_at, stripe_connection_id, deleted_at) VALUES (?, ?, 'cus_alert', 'buyer@acme.test', 11, 2026, 1000, ?, ?)",
    )
    .run(id, ACCOUNT, opts.connectionId === undefined ? "c1" : opts.connectionId, opts.deleted ? 2000 : null);
}

function seedFailedPayment(id = "fp_1", status = "active"): void {
  sqlite
    .prepare(
      "INSERT INTO failed_payments (id, account_id, stripe_event_id, stripe_invoice_id, stripe_customer_id, customer_email, amount_cents, currency, decline_category, status, detected_at, stripe_connection_id, subscription_id) VALUES (?, ?, 'evt', 'in_1', 'cus_fp', 'buyer@acme.test', 9900, 'usd', 'expired', ?, 1000, 'c1', 'sub_1')",
    )
    .run(id, ACCOUNT, status);
}

async function load(token: string, search = ""): Promise<Record<string, unknown>> {
  const res = (await loader({
    context: ctx,
    request: new Request(`https://foxhoundapp.test/p/${token}${search}`),
    params: { token },
  } as never)) as unknown as { data: Record<string, unknown> };
  return res.data;
}

function stepRows() {
  return sqlite
    .prepare("SELECT id, step_type AS stepType, result FROM recovery_steps")
    .all() as { id: string; stepType: string; result: string | null }[];
}

describe("PLANT 2: alert mode saves a card and enters no retry path", () => {
  it("renders ready with NO amount line, because nothing has failed", async () => {
    seedAlert();
    const token = await signCardUpdateToken(ENV, { expiringCardAlertId: "al_1", accountId: ACCOUNT });

    const state = await load(token);

    expect(state.state).toBe("ready");
    expect(state.amountCents).toBeUndefined();
    expect(state.currency).toBeUndefined();
  });

  it("opens a Checkout session for the ALERT's customer", async () => {
    seedAlert();
    const token = await signCardUpdateToken(ENV, { expiringCardAlertId: "al_1", accountId: ACCOUNT });

    const res = (await action({
      context: ctx,
      request: new Request(`https://foxhoundapp.test/p/${token}`, { method: "POST" }),
      params: { token },
    } as never)) as unknown as Response;

    expect(res.status).toBe(302);
    expect(harness.sessions).toHaveLength(1);
    expect(harness.sessions[0].customerId).toBe("cus_alert");
  });

  it("FINALIZES WITH NO SUBSCRIPTION AND WRITES NO RECOVERY STEP", async () => {
    seedAlert();
    const token = await signCardUpdateToken(ENV, { expiringCardAlertId: "al_1", accountId: ACCOUNT });

    await expect(load(token, "?session_id=cs_1")).rejects.toMatchObject({ status: 302 });

    expect(harness.finalized).toHaveLength(1);
    // finalizeCardUpdateSession updates the CUSTOMER default either way; only a
    // subscription id would pin a subscription, and an alert has none.
    expect(harness.finalized[0].subscriptionId).toBeNull();
    // No attribution signal: no recovery_steps row of any kind.
    expect(stepRows()).toEqual([]);
  });

  it("a soft-deleted alert is invalid, not an invitation to update a card", async () => {
    seedAlert("al_1", { deleted: true });
    const token = await signCardUpdateToken(ENV, { expiringCardAlertId: "al_1", accountId: ACCOUNT });
    expect(await load(token)).toEqual({ state: "invalid" });
  });
});

describe("PLANT 3: the failed-payment mode is unchanged", () => {

  it("still finalizes WITH the subscription and DOES write the attribution signal", async () => {
    seedFailedPayment();
    const token = await signCardUpdateToken(ENV, { failedPaymentId: "fp_1", accountId: ACCOUNT });

    await expect(load(token, "?session_id=cs_1")).rejects.toMatchObject({ status: 302 });

    expect(harness.finalized[0].subscriptionId).toBe("sub_1");
    const steps = stepRows();
    expect(steps).toHaveLength(1);
    expect(steps[0].stepType).toBe("card_update");
    expect(steps[0].result).toBe("card_updated");
  });

  it("still reports a resolved payment as resolved", async () => {
    seedFailedPayment("fp_1", "recovered");
    const token = await signCardUpdateToken(ENV, { failedPaymentId: "fp_1", accountId: ACCOUNT });
    expect(await load(token)).toEqual({ state: "resolved" });
  });
});
