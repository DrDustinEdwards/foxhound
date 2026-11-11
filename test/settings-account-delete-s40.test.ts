import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";

// S40, the surface half: the Delete account control on /settings/account, the
// route branch that runs it, and the rule that it never becomes an agent tool.
// The deletion itself is proven in account-deletion-s40.test.ts.
//
// The control is Capsomer's DeleteAccount on /settings/account.

const harness = vi.hoisted(() => ({
  deleteCalls: 0,
  signedInAt: new Date(),
}));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => ({}),
}));

vi.mock("~/lib/auth/auth.server", () => ({
  getAuth: () => ({
    api: {
      getSession: async () => ({
        session: { createdAt: harness.signedInAt },
        user: { id: "user_1" },
      }),
      // Better Auth's /delete-user, whose hooks are the deletion; it takes no
      // id, so the session's user is the one deleted.
      deleteUser: async () => {
        harness.deleteCalls += 1;
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
    if (key === cloudflareContext) return { env: {} as Env, ctx: {} as ExecutionContext };
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
      request: new Request("https://foxhoundapp.test/settings/account", {
        method: "POST",
        body: form,
      }),
      params: {},
    } as never);
  } catch (thrown) {
    // react-router's redirect() is returned or thrown depending on the caller.
    return thrown;
  }
}

beforeEach(() => {
  harness.deleteCalls = 0;
  harness.signedInAt = new Date();
});

describe("S40: the delete-account post", () => {
  // The post itself is site-runtime's accountFormAction, tested there (the
  // ticked box, a stale sign-in, a refusal); this is Foxhound's landing.
  it("deletes the SIGNED-IN user, signs them out and sends them home, as Recova does", async () => {
    const res = (await post({ intent: "delete-account", confirm: "on" })) as Response;
    expect(harness.deleteCalls).toBe(1);
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/");
    expect(res.headers.get("Set-Cookie")).toContain("better-auth.session_token=;");
  });
});

describe("S40: deletion is never an agent tool (RULES.md 3.6)", () => {
  it("no agent surface reaches the deletion module", () => {
    const read = (p: string) =>
      readFileSync(fileURLToPath(new URL(`../${p}`, import.meta.url)), "utf8");
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
