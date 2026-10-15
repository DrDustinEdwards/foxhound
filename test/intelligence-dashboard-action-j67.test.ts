import { describe, expect, it, vi } from "vitest";

import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";

// J67: the dashboard's action is the one door to report generation. It takes
// the account from the session, never from the form (RULES.md 4.6), checks the
// Intelligence entitlement the page itself checks, and hands the month to
// generateMonthlyReport, whose result the page shows.

const generateMonthlyReport = vi.fn();
const isIntelligenceEntitled = vi.fn();
vi.mock("~/lib/intelligence/report-generate.server", () => ({ generateMonthlyReport }));
vi.mock("~/lib/intelligence/views.server", async (orig) => ({
  ...(await orig<object>()),
  isIntelligenceEntitled,
}));
vi.mock("~/db", async (orig) => ({ ...(await orig<object>()), getDb: () => ({ fake: "db" }) }));

const route = await import("~/routes/app/intelligence/index");

function ctx() {
  return {
    get(key: unknown) {
      if (key === cloudflareContext) return { env: { ANTHROPIC_API_KEY: "k" } as unknown as Env, ctx: {}, nonce: "n" };
      if (key === authContext) {
        return {
          userId: "user_1",
          email: "owner@acme.test",
          isDemo: false,
          membership: { memberId: "m1", accountId: "acct_session", accountName: "Acme", role: "member" },
          memberships: [],
        };
      }
      throw new Error("unexpected context key");
    },
  } as never;
}

async function post(fields: Record<string, string>) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return route.action({
    context: ctx(),
    request: new Request("https://foxhoundapp.test/intelligence/dashboard", { method: "POST", body: form }),
    params: {},
  } as never);
}

describe("/intelligence/dashboard action", () => {
  it("generates for the session's account and the posted month, ignoring any posted account", async () => {
    isIntelligenceEntitled.mockResolvedValue(true);
    generateMonthlyReport.mockResolvedValue({ ok: true, month: "2026-10", narrative: "Hi." });
    const result = await post({ intent: "generate", month: "2026-10", accountId: "acct_other" });
    expect(generateMonthlyReport).toHaveBeenCalledTimes(1);
    const [, db, accountId, month] = generateMonthlyReport.mock.calls[0]!;
    expect(db).toEqual({ fake: "db" });
    expect(accountId).toBe("acct_session");
    expect(month).toBe("2026-10");
    expect(result).toEqual({ ok: true, month: "2026-10", narrative: "Hi." });
  });

  it("refuses an account without Intelligence, generating nothing", async () => {
    generateMonthlyReport.mockClear();
    isIntelligenceEntitled.mockResolvedValue(false);
    const result = await post({ intent: "generate", month: "2026-10" });
    expect(generateMonthlyReport).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, error: "not_entitled" });
  });

  it("refuses an unknown intent", async () => {
    generateMonthlyReport.mockClear();
    isIntelligenceEntitled.mockResolvedValue(true);
    const result = await post({ intent: "delete" });
    expect(generateMonthlyReport).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false });
  });
});
