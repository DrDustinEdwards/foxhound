import { describe, expect, it, vi } from "vitest";

import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";

// J67: the dashboard's action is the one door to report generation. It takes
// the account from the session, never from the form, and hands
// the month to generateMonthlyReport, whose result the page shows.

const generateMonthlyReport = vi.fn();
vi.mock("~/lib/intelligence/report-generate.server", () => ({ generateMonthlyReport }));
vi.mock("~/db", async (orig) => ({ ...(await orig<object>()), getDb: () => ({ fake: "db" }) }));

const route = await import("~/routes/app/intelligence/index");

function ctx(isDemo = false) {
  return {
    get(key: unknown) {
      if (key === cloudflareContext) return { env: { ANTHROPIC_API_KEY: "k" } as unknown as Env, ctx: {}, nonce: "n" };
      if (key === authContext) {
        return {
          userId: "user_1",
          email: "owner@acme.test",
          isDemo,
          membership: { memberId: "m1", accountId: "acct_session", accountName: "Acme", role: "member" },
          memberships: [],
        };
      }
      throw new Error("unexpected context key");
    },
  } as never;
}

async function post(fields: Record<string, string>, isDemo = false) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return route.action({
    context: ctx(isDemo),
    request: new Request("https://foxhoundapp.test/intelligence/dashboard", { method: "POST", body: form }),
    params: {},
  } as never);
}

/** The action's answer as the fetcher sees it: a status and a body. A plain
 *  return is a 200; data(body, { status }) carries its own. */
async function answer(fields: Record<string, string>, isDemo = false) {
  const result = (await post(fields, isDemo)) as unknown;
  if (result && typeof result === "object" && "init" in result && "data" in result) {
    const r = result as { data: unknown; init?: { status?: number } | null };
    return { status: r.init?.status ?? 200, body: r.data };
  }
  return { status: 200, body: result };
}

describe("/intelligence/dashboard action", () => {
  it("generates for the session's account and the posted month, ignoring any posted account", async () => {
    generateMonthlyReport.mockResolvedValue({ ok: true, month: "2026-10", narrative: "Hi." });
    const { status, body: result } = await answer({ intent: "generate", month: "2026-10", accountId: "acct_other" });
    expect(status).toBe(200);
    expect(generateMonthlyReport).toHaveBeenCalledTimes(1);
    const [, db, accountId, month] = generateMonthlyReport.mock.calls[0]!;
    expect(db).toEqual({ fake: "db" });
    expect(accountId).toBe("acct_session");
    expect(month).toBe("2026-10");
    expect(result).toEqual({ ok: true, month: "2026-10", narrative: "Hi." });
  });

  it("refuses an unknown intent", async () => {
    generateMonthlyReport.mockClear();
    const { status, body } = await answer({ intent: "delete" });
    expect(generateMonthlyReport).not.toHaveBeenCalled();
    expect(body).toMatchObject({ ok: false, error: "invalid_intent" });
    expect(status).toBe(400);
  });

  it("refuses the demo with a 403, generating nothing", async () => {
    generateMonthlyReport.mockClear();
    const { status, body } = await answer({ intent: "generate", month: "2026-10" }, true);
    expect(generateMonthlyReport).not.toHaveBeenCalled();
    expect(body).toMatchObject({ ok: false, error: "demo_read_only" });
    expect(status).toBe(403);
  });

  // Each refusal comes back with a status that says what it is, not a 200.
  it.each([
    ["invalid_month", 400],
    ["not_current_month", 400],
    ["rate_limited", 429],
  ] as const)("answers %s with %i", async (error, expected) => {
    generateMonthlyReport.mockResolvedValue({ ok: false, error });
    const { status, body } = await answer({ intent: "generate", month: "2026-10" });
    expect(body).toEqual({ ok: false, error });
    expect(status).toBe(expected);
  });

  it("keeps a thrown read in the card as a 500", async () => {
    generateMonthlyReport.mockRejectedValue(new Error("D1_ERROR: no such table"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { status, body } = await answer({ intent: "generate", month: "2026-10" });
    expect(body).toEqual({ ok: false, error: "server_error" });
    expect(status).toBe(500);
    log.mockRestore();
  });
});
