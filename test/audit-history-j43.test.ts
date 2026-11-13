import { beforeEach, describe, expect, it, vi } from "vitest";

import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";

import { createInMemoryDb } from "./helpers/inmemory-db";

// J43, row U2: the signed-in audit history is Recova's
// /audit/dashboard (app/audit/dashboard/page.tsx at blob 988c190a and
// AuditSettingsForm.tsx at blob 9016a436, both read whole), built from Capsomer
// 0.9.0's parts and amber throughout. Recova is the spec for the
// path, every section and its order: the header with Run new audit, the AI
// summary, Since last run, History, and the Settings card with the lookback
// period and the monthly digest, saving as they change.

const harness = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const ACCOUNT_A = "acct_alpha";
const ACCOUNT_B = "acct_beta";

let sqlite: ReturnType<typeof createInMemoryDb>["sqlite"];

beforeEach(() => {
  const made = createInMemoryDb();
  sqlite = made.sqlite;
  harness.db = made.db;
  for (const id of [ACCOUNT_A, ACCOUNT_B]) {
    sqlite.prepare("INSERT INTO accounts (id, name, created_at) VALUES (?, ?, 1000)").run(id, id);
  }
});

function contextFor(accountId: string): unknown {
  return {
    get(key: unknown) {
      if (key === cloudflareContext) return { env: {} as Env, ctx: {} as ExecutionContext };
      if (key === authContext) {
        return {
          userId: "user_1",
          userName: "user_1",
          email: "owner@alpha.test",
          membership: { memberId: "m", accountId, accountName: accountId, role: "owner" },
          memberships: [],
          activeAccountId: accountId,
          isAdmin: false,
          isDemo: false,
          demoSignedIn: false,
        };
      }
      throw new Error("unexpected context key");
    },
  };
}

const page = await import("~/routes/app/audit/dashboard");

describe("J43: the loader and the action, scoped to the caller's account", () => {
  const callAction = (accountId: string, form: Record<string, string>) => {
    const body = new FormData();
    for (const [k, v] of Object.entries(form)) body.set(k, v);
    return page.action({
      request: new Request("https://foxhoundapp.test/audit/dashboard", { method: "POST", body }),
      context: contextFor(accountId),
      params: {},
    } as never) as Promise<{ data: Record<string, unknown>; init: { status?: number } | null }>;
  };
  const loadPage = (accountId: string) =>
    page.loader({
      request: new Request("https://foxhoundapp.test/audit/dashboard"),
      context: contextFor(accountId),
      params: {},
    } as never) as Promise<{ settings: { lookbackDays: number; autoRun: boolean } }>;
  const stored = (id: string) =>
    sqlite
      .prepare("SELECT audit_lookback_days AS d, audit_auto_run AS a FROM accounts WHERE id = ?")
      .get(id) as {
      d: number | null;
      a: number | null;
    };

  it("the loader reads this account's settings, NULL as 90 days and off", async () => {
    sqlite
      .prepare("UPDATE accounts SET audit_lookback_days = 30, audit_auto_run = 1 WHERE id = ?")
      .run(ACCOUNT_B);
    expect((await loadPage(ACCOUNT_A)).settings).toEqual({ lookbackDays: 90, autoRun: false });
    expect((await loadPage(ACCOUNT_B)).settings).toEqual({ lookbackDays: 30, autoRun: true });
  });

  it("the action writes the caller's account and no other", async () => {
    const res = await callAction(ACCOUNT_A, { audit_lookback_days: "180", audit_auto_run: "true" });
    expect(res.init?.status ?? 200).toBe(200);
    expect(res.data).toMatchObject({ ok: true, lookbackDays: 180, autoRun: true });
    expect(stored(ACCOUNT_A)).toEqual({ d: 180, a: 1 });
    expect(stored(ACCOUNT_B)).toEqual({ d: null, a: null });
  });

  it("a failed write returns 500 with ok false and logs the whole error", async () => {
    const boom = new Error("D1 is down");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const realDb = harness.db;
    harness.db = new Proxy(realDb as object, {
      get(target, prop, receiver) {
        if (prop === "update" || prop === "batch") throw boom;
        return Reflect.get(target, prop, receiver);
      },
    });
    try {
      const res = await callAction(ACCOUNT_A, { audit_lookback_days: "60" });
      expect(res.init?.status).toBe(500);
      expect(res.data).toEqual({ ok: false });
      expect(spy).toHaveBeenCalledWith(expect.any(String), boom);
    } finally {
      harness.db = realDb;
      spy.mockRestore();
    }
  });
});
