import { drizzle } from "drizzle-orm/d1";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as schema from "~/db/schema";
import { buildCardUpdateSignal } from "~/lib/card-update/signal";
import { signCardUpdateToken, verifyCardUpdateToken } from "~/lib/card-update/token";
import { CARD_UPDATE_TOKEN_MAX_AGE_MS } from "~/lib/constants";
import {
  resolveConnectionForFailedPayment,
  type ConnectionCandidate,
} from "~/routes/utility/card-update";

const db = drizzle({} as never, { schema });
function sqlOf(item: unknown): { sql: string; params: unknown[] } {
  return (item as { toSQL(): { sql: string; params: unknown[] } }).toSQL();
}

// 64 hex chars = 32-byte HMAC key.
const env = { ENCRYPTION_KEY: "a".repeat(64) } as unknown as Env;

describe("card-update token sign/verify", () => {
  it("round-trips a payload and stamps iat", async () => {
    const before = Date.now();
    const token = await signCardUpdateToken(env, {
      failedPaymentId: "fp_1",
      accountId: "acc_1",
    });
    const payload = await verifyCardUpdateToken(env, token);
    expect(payload?.failedPaymentId).toBe("fp_1");
    expect(payload?.accountId).toBe("acc_1");
    expect(payload?.iat).toBeGreaterThanOrEqual(before);
  });

  it("rejects a tampered token", async () => {
    const token = await signCardUpdateToken(env, { failedPaymentId: "fp_1", accountId: "acc_1" });
    const [payloadPart, sig] = token.split(".");
    const tampered = `${payloadPart.slice(0, -1)}${payloadPart.slice(-1) === "A" ? "B" : "A"}.${sig}`;
    expect(await verifyCardUpdateToken(env, tampered)).toBeNull();
  });

  it("rejects a garbage token", async () => {
    expect(await verifyCardUpdateToken(env, "not-a-token")).toBeNull();
  });

  it("rejects a well-formed token signed with a different key", async () => {
    const otherEnv = { ENCRYPTION_KEY: "b".repeat(64) } as unknown as Env;
    const token = await signCardUpdateToken(otherEnv, { failedPaymentId: "fp_1", accountId: "acc_1" });
    expect(await verifyCardUpdateToken(env, token)).toBeNull();
  });

  describe("expiry", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("accepts a token right up to the max age", async () => {
      vi.setSystemTime(new Date("2026-07-01T00:00:00.000Z"));
      const token = await signCardUpdateToken(env, { failedPaymentId: "fp_1", accountId: "acc_1" });
      vi.setSystemTime(new Date(Date.now() + CARD_UPDATE_TOKEN_MAX_AGE_MS - 1));
      expect(await verifyCardUpdateToken(env, token)).not.toBeNull();
    });

    it("rejects a token older than the max age (expired)", async () => {
      vi.setSystemTime(new Date("2026-07-01T00:00:00.000Z"));
      const token = await signCardUpdateToken(env, { failedPaymentId: "fp_1", accountId: "acc_1" });
      vi.setSystemTime(new Date(Date.now() + CARD_UPDATE_TOKEN_MAX_AGE_MS + 1));
      expect(await verifyCardUpdateToken(env, token)).toBeNull();
    });
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

  it("returns a clean null (not a crash) when the referenced connection is missing or disconnected", () => {
    expect(resolveConnectionForFailedPayment([connA, connB], "conn_missing")).toBeNull();
    expect(resolveConnectionForFailedPayment([], "conn_a")).toBeNull();
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
