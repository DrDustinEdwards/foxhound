import { describe, expect, it, vi } from "vitest";

// exchangeConnectCode refuses a test-mode token: Foxhound ignores every
// test-mode webhook, so a connection made under a test key would look live and
// never recover a payment.

const token = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));

vi.mock("~/lib/stripe/client", () => ({
  getStripe: () => ({ oauth: { token: async () => token.value } }),
}));

const { exchangeConnectCode } = await import("~/lib/stripe/connect");

const grant = { stripe_user_id: "acct_1", access_token: "secret_token", scope: "read_write" };

describe("exchangeConnectCode", () => {
  it("accepts a live token and refuses a test-mode one without quoting it", async () => {
    token.value = { ...grant, livemode: true };
    await expect(exchangeConnectCode({} as Env, "ac_1")).resolves.toMatchObject({ stripeUserId: "acct_1" });

    token.value = { ...grant, livemode: false };
    const refused = await exchangeConnectCode({} as Env, "ac_1").catch((err: Error) => err.message);
    expect(refused).toMatch(/test-mode token/);
    expect(refused).not.toContain("secret_token");
  });
});
