import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";

// S40, the surface half: the Delete account control on /settings/account, the
// route branch that runs it, and the rule that it never becomes an agent tool
// (RULES.md 3.6). The deletion itself is proven in account-deletion-s40.test.ts.
//
// J32 (/settings/account rebuilt on Capsomer, job_54cb0e7420dc) has not merged,
// so the control sits on Foxhound's current page, in its Danger zone, which is
// where Recova's AccountSection puts it (blob a154ac8f).

const harness = vi.hoisted(() => ({
  deleteCalls: [] as string[],
  deleteResult: { status: "deleted", accountIds: ["acct_1"], deauthorizeErrors: [] } as unknown,
  deleteThrows: false,
  signOutCalls: 0,
}));

vi.mock("~/lib/auth/delete-account.server", () => ({
  deleteUserAccount: async (_env: unknown, userId: string) => {
    harness.deleteCalls.push(userId);
    if (harness.deleteThrows) throw new Error("D1 batch failed");
    return harness.deleteResult;
  },
}));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => ({}),
}));

vi.mock("~/lib/auth/auth.server", () => ({
  getAuth: () => ({
    api: {
      signOut: async () => {
        harness.signOutCalls += 1;
        return new Response(JSON.stringify({ success: true }), {
          headers: { "set-cookie": "better-auth.session_token=; Max-Age=0; Path=/" },
        });
      },
    },
  }),
}));

const { action, default: AccountSettings } = await import("~/routes/app/settings/account");

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
  harness.deleteCalls = [];
  harness.deleteResult = { status: "deleted", accountIds: ["acct_1"], deauthorizeErrors: [] };
  harness.deleteThrows = false;
  harness.signOutCalls = 0;
});

describe("S40: the delete-account action", () => {
  it("deletes the SIGNED-IN user, signs them out and sends them home, as Recova does", async () => {
    const res = (await post({ _action: "delete-account" })) as Response;
    expect(harness.deleteCalls).toEqual(["user_1"]);
    expect(harness.signOutCalls).toBe(1);
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/");
    expect(res.headers.get("Set-Cookie")).toContain("better-auth.session_token=;");
  });

  it("ignores any user or account id posted with the form", async () => {
    await post({ _action: "delete-account", userId: "user_victim", accountId: "acct_victim" });
    expect(harness.deleteCalls).toEqual(["user_1"]);
  });

  it("on failure keeps the person signed in and tells them, in Recova's words", async () => {
    harness.deleteThrows = true;
    const res = (await post({ _action: "delete-account" })) as { data: Record<string, unknown>; init?: { status?: number } };
    expect(harness.signOutCalls).toBe(0);
    expect(res.init?.status).toBe(500);
    expect(res.data).toEqual({
      action: "delete-account",
      ok: false,
      error: "Failed to delete account. Please contact support.",
    });
  });
});

describe("S40: the Danger zone control", () => {
  function render(cancelledAt: Date | null): string {
    const Stub = createRoutesStub([
      {
        path: "/",
        Component: () =>
          createElement(AccountSettings as never, {
            loaderData: {
              account: { name: "Acme", merchantIndustry: null, primaryCustomerType: null, merchantMrrSelfReported: null },
              cancelledAt,
              userEmail: "owner@acme.test",
              ownedAccountNames: ["Acme"],
            },
            actionData: undefined,
          }),
      },
    ]);
    return renderToStaticMarkup(createElement(Stub));
  }

  it("offers Delete account in the Danger zone, with Recova's label", () => {
    const html = render(null);
    expect(html).toContain("Danger zone");
    expect(html).toMatch(/<button[^>]*type="button"[^>]*>Delete account<\/button>/);
  });

  it("still offers it once the account is cancelled", () => {
    const html = render(new Date(0));
    expect(html).toMatch(/<button[^>]*>Delete account<\/button>/);
  });

  it("posts the delete-account intent, and its confirm copy tells the truth about what is kept", () => {
    const source = readFileSync(fileURLToPath(new URL("../app/routes/app/settings/account.tsx", import.meta.url)), "utf8");
    expect(source).toContain('value="delete-account"');
    expect(source).toContain("Yes, delete my account");
    expect(source).toContain("Keep my account");
    // Recova's copy says "all payment data" is deleted. Foxhound keeps the
    // record of recovered payments (Q14), so that sentence would be false here.
    expect(source).not.toContain("all payment data");
    // The words are per case (review fix F2), built by deletionConsequence.
    expect(source).toContain("{deletionConsequence(ownedAccountNames)}");
    const copy = readFileSync(fileURLToPath(new URL("../app/lib/auth/deletion-copy.ts", import.meta.url)), "utf8");
    expect(copy).not.toContain("all payment data");
    expect(copy).toMatch(/keeps the amounts, dates and Stripe ids of the payments it recovered/);
  });
});

describe("S40: deletion is never an agent tool (RULES.md 3.6)", () => {
  it("the tool registry refuses any delete-account name", async () => {
    const { isDeniedToolName } = await import("~/lib/mcp/registry");
    for (const name of ["foxhound_delete_account", "foxhound_account_delete", "delete_account", "foxhound_delete_user"]) {
      expect(isDeniedToolName(name), name).toBe(true);
    }
  });

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
