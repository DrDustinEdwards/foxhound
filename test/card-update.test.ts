import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it, vi } from "vitest";

import * as schema from "~/db/schema";
import { finalizeCardUpdateSession } from "~/lib/card-update/service";
import { buildCardUpdateSignal } from "~/lib/card-update/signal";
import { signCardUpdateToken, verifyCardUpdateToken } from "~/lib/card-update/token";
import {
  resolveConnectionForFailedPayment,
  type ConnectionCandidate,
} from "~/routes/utility/card-update";

const stripe = vi.hoisted(() => ({
  session: {} as Record<string, unknown>,
  updated: [] as string[],
}));
vi.mock("~/lib/stripe/client", () => ({
  getConnectedStripe: () => ({
    checkout: { sessions: { retrieve: async () => stripe.session } },
    customers: {
      update: async (id: string) => {
        stripe.updated.push(id);
      },
    },
  }),
}));

const db = drizzle({} as never, { schema });
function sqlOf(item: unknown): { sql: string; params: unknown[] } {
  return (item as { toSQL(): { sql: string; params: unknown[] } }).toSQL();
}

// 64 hex chars = 32-byte HMAC key.
const env = { ENCRYPTION_KEY: "a".repeat(64) } as unknown as Env;

describe("card-update token sign/verify", () => {
  it("rejects a well-formed token signed with a different key", async () => {
    const otherEnv = { ENCRYPTION_KEY: "b".repeat(64) } as unknown as Env;
    const token = await signCardUpdateToken(otherEnv, {
      failedPaymentId: "fp_1",
      accountId: "acc_1",
    });
    expect(await verifyCardUpdateToken(env, token)).toBeNull();
  });
});

describe("resolveConnectionForFailedPayment (Phase 5 review MEDIUM fix)", () => {
  const connA: ConnectionCandidate = { id: "conn_a", stripeAccessToken: "enc_a" };
  const connB: ConnectionCandidate = { id: "conn_b", stripeAccessToken: "enc_b" };

  it("picks the connection tied to the failed payment when the account has more than one active connection", () => {
    expect(resolveConnectionForFailedPayment([connA, connB], "conn_b")).toEqual(connB);
  });

  it("falls back to the single active connection for older rows with no stripe_connection_id recorded", () => {
    expect(resolveConnectionForFailedPayment([connA], null)).toEqual(connA);
  });

  it("never guesses among multiple connections when stripe_connection_id is null", () => {
    expect(resolveConnectionForFailedPayment([connA, connB], null)).toBeNull();
  });
});

describe("buildCardUpdateSignal (compiles against schema)", () => {
  it("inserts a card_update recovery_steps row, executed now, result card_updated", () => {
    const now = new Date("2026-07-18T00:00:00.000Z");
    const { sql, params } = sqlOf(
      buildCardUpdateSignal(db, { failedPaymentId: "fp_1", accountId: "acc_1", occurredAt: now }),
    );
    expect(sql).toMatch(/insert into .*recovery_steps/i);
    expect(params).toContain("card_update");
    expect(params).toContain("card_updated");
    expect(params).toContain("fp_1");
    expect(params).toContain("acc_1");
    expect(params).toContain(now.getTime());
  });
});

describe("finalizeCardUpdateSession: only the session this link made", () => {
  // Mythos billing review, finding 3. session_id is a URL parameter, and any
  // completed setup session on the merchant's account used to be accepted, so
  // a billable card_update was recorded with no new card.
  const link = { accessToken: "tok", sessionId: "cs_1", customerId: "cus_link", linkRef: "fp_1" };
  const made = {
    mode: "setup",
    status: "complete",
    customer: "cus_link",
    client_reference_id: "fp_1",
    setup_intent: { payment_method: "pm_new" },
  };

  it.each([
    ["another customer's session", { customer: "cus_other" }],
    ["a session made for another link", { client_reference_id: "fp_2" }],
    ["a session with no link reference", { client_reference_id: null }],
    ["a payment-mode session", { mode: "payment" }],
  ])("refuses %s and changes nothing", async (_name, over) => {
    stripe.session = { ...made, ...over };
    stripe.updated = [];
    expect((await finalizeCardUpdateSession(link)).ok).toBe(false);
    expect(stripe.updated).toEqual([]);
  });

  it("accepts the session this link made", async () => {
    stripe.session = made;
    stripe.updated = [];
    expect(await finalizeCardUpdateSession(link)).toEqual({ ok: true });
    expect(stripe.updated).toEqual(["cus_link"]);
  });
});
