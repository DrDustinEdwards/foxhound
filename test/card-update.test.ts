import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { signCardUpdateToken, verifyCardUpdateToken } from "~/lib/card-update/token";
import { CARD_UPDATE_TOKEN_MAX_AGE_MS } from "~/lib/constants";

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
