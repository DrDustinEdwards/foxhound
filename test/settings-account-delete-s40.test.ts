import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";

// S40, the surface half: the Delete account control on /settings/account, the
// route branch that runs it, and the rule that it never becomes an agent tool.
// The deletion itself is proven in account-deletion-s40.test.ts.
//
// J32 (/settings/account rebuilt on Capsomer) has not merged,
// so the control sits on Foxhound's current page, in its Danger zone, which is
// where Recova's AccountSection puts it (blob a154ac8f).

const harness = vi.hoisted(() => ({
  deleteCalls: 0,
  deleteThrows: false,
  signedInAt: new Date(),
}));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => ({}),
}));

vi.mock("~/lib/auth/auth.server", () => ({
  getAuth: () => ({
    api: {
      getSession: async () => ({ session: { createdAt: harness.signedInAt }, user: { id: "user_1" } }),
      // Better Auth's /delete-user, whose hooks are the deletion; it takes no
      // id, so the session's user is the one deleted.
      deleteUser: async () => {
        harness.deleteCalls += 1;
        if (harness.deleteThrows) throw new Error("D1 batch failed");
        return new Response(JSON.stringify({ success: true }), {
          headers: { "set-cookie": "better-auth.session_token=; Max-Age=0; Path=/" },
        });
      },
    },
  }),
}));

const { action } = await import("~/routes/app/settings/account");

const ctx = {
  get(key: unknown) {
    if (key === cloudflareContext) return { env: {} as Env, ctx: {} as ExecutionContext, nonce: "n" };
    if (key === authContext) {
      return {
        userId: "user_1",
        userName: "Owner",
        email: "owner@acme.test",
        membership: { memberId: "m1", accountId: "acct_1", accountName: "Acme", role: "owner" },
        memberships: [{ memberId: "m1", accountId: "acct_1", accountName: "Acme", role: "owner" }],
        activeAccountId: "acct_1",
        isAdmin: false,
        isDemo: false,
        demoSignedIn: false,
      };
    }
    throw new Error("unexpected context key");
  },
};

async function post(fields: Record<string, string>): Promise<unknown> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  try {
    return await action({
      context: ctx,
      request: new Request("https://foxhoundapp.test/settings/account", { method: "POST", body: form }),
      params: {},
    } as never);
  } catch (thrown) {
    // react-router's redirect() is returned or thrown depending on the caller.
    return thrown;
  }
}

beforeEach(() => {
  harness.deleteCalls = 0;
  harness.deleteThrows = false;
  harness.signedInAt = new Date();
});

describe("S40: the delete-account action", () => {
  it("deletes the SIGNED-IN user, signs them out and sends them home, as Recova does", async () => {
    const res = (await post({ _action: "delete-account" })) as Response;
    expect(harness.deleteCalls).toBe(1);
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/");
    expect(res.headers.get("Set-Cookie")).toContain("better-auth.session_token=;");
  });

  it("refuses a sign-in older than 10 minutes and deletes nothing", async () => {
    harness.signedInAt = new Date(Date.now() - 11 * 60_000);
    const res = (await post({ _action: "delete-account" })) as { data: Record<string, unknown>; init?: { status?: number } };
    expect(harness.deleteCalls).toBe(0);
    expect(res.init?.status).toBe(403);
    expect(res.data).toEqual({ action: "delete-account", ok: false, error: "stale" });
  });

  it("on failure keeps the person signed in and tells them, in Recova's words", async () => {
    harness.deleteThrows = true;
    const res = (await post({ _action: "delete-account" })) as { data: Record<string, unknown>; init?: { status?: number } };
    expect(res.init?.status).toBe(500);
    expect(res.data).toEqual({
      action: "delete-account",
      ok: false,
      error: "Failed to delete account. Please contact support.",
    });
  });
});

describe("S40: deletion is never an agent tool (RULES.md 3.6)", () => {

  it("no agent surface reaches the deletion module", () => {
    const read = (p: string) => readFileSync(fileURLToPath(new URL(`../${p}`, import.meta.url)), "utf8");
    for (const path of [
      "app/lib/mcp/tools.server.ts",
      "app/lib/mcp/server.ts",
      "app/lib/mcp/handler.server.ts",
      "app/lib/admin-api/handler.server.ts",
    ]) {
      const source = read(path);
      expect(source, path).not.toContain("delete-account");
      expect(source, path).not.toContain("deleteUserAccount");
    }
  });
});
