import type Database from "better-sqlite3";
import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cronConfig } from "~/db";
import { adminContext } from "~/lib/admin/context";
import { RECOVERY_TICK_CRON_NAME } from "~/lib/constants";
import { auditEntryDetail } from "~/lib/admin/audit-describe";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";

import { createInMemoryDb, inMemoryMoneyWriter } from "./helpers/inmemory-db";

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));
vi.mock("~/lib/stripe/connect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/stripe/connect")>()),
  deauthorizeConnectedAccount: async () => ({ ok: true }),
}));

const { action: cronsAction } = await import("~/routes/admin/crons");
const { action: merchantAction } = await import("~/routes/admin/merchants/detail");
const { action: merchantsAction } = await import("~/routes/admin/merchants/index");

interface Entry {
  action: string;
  metadata: unknown;
  targetEmail: string | null;
  targetUserId: string | null;
}

const entry = (action: string, metadata: unknown, targetEmail: string | null = null): Entry => ({
  action,
  metadata,
  targetEmail,
  targetUserId: null,
});

const detail = auditEntryDetail;

describe("the fallback never shows a secret or a long value", () => {
  it("skips keys that may hold a credential, an address or a Stripe user", () => {
    expect(
      detail(
        entry("something.new", {
          api_token: "t",
          client_secret: "s",
          keyId: "k",
          password: "p",
          stripe_user_id: "acct_1",
          email: "a@example.com",
          recipient: "self",
          stage: "two",
        }),
      ),
    ).toBe("stage: two");
    expect(detail(entry("impersonation_start", { target_email: "a@example.com" }))).toBeNull();
  });
});

// A failed audit write leaves the admin change undone.

const fakeContext = {
  get(key: unknown) {
    if (key === cloudflareContext) return { env: {} as Env, ctx: {} as ExecutionContext };
    if (key === adminContext) return { email: "admin@foxhoundapp.com" };
    throw new Error("unexpected context key");
  },
} as unknown as Parameters<typeof cronsAction>[0]["context"];

function postTo(url: string, fields: Record<string, string>) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.append(k, v);
  return new Request(url, { method: "POST", body });
}

describe("the cron toggles write the audit row with the change", () => {
  it("/admin/crons: a failed audit insert leaves the cron's enabled state untouched", async () => {
    const { db, sqlite } = createInMemoryDb();
    harness.db = db;
    sqlite.exec("drop table admin_audit_log");

    await expect(
      cronsAction({
        context: fakeContext,
        request: postTo("http://localhost/admin/crons", {
          cronName: RECOVERY_TICK_CRON_NAME,
          nextEnabled: "false",
        }),
        params: {},
      } as never),
    ).rejects.toThrow();

    expect(await db.select().from(cronConfig)).toEqual([]);
  });
});

let sqlite: Database.Database;

function postMerchant(fields: Record<string, string>, act: unknown = merchantAction) {
  const c = new RouterContextProvider();
  c.set(cloudflareContext, {
    env: { MONEY_WRITER: inMemoryMoneyWriter(() => sqlite).binding } as unknown as Env,
    ctx: {} as ExecutionContext,
  });
  c.set(adminContext, { email: "admin@example.com" });
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.append(k, v);
  return (act as (args: unknown) => Promise<unknown>)({
    request: new Request("https://foxhoundapp.com/admin/merchants/acc_1", { method: "POST", body }),
    context: c,
    params: { id: "acc_1" },
  });
}

function accountRow() {
  return sqlite
    .prepare(
      "SELECT billing_exempt AS exempt, processing_paused AS paused, cancelled_at AS canceled FROM accounts WHERE id = 'acc_1'",
    )
    .get();
}

describe("an admin change on the merchant page never stands without its audit row", () => {
  beforeEach(() => {
    const made = createInMemoryDb();
    sqlite = made.sqlite;
    // D1 runs a batch as one transaction; the shared shim does not, so this one does.
    (made.db as unknown as { batch: (s: unknown[]) => Promise<unknown[]> }).batch = async (
      stmts,
    ) => {
      sqlite.exec("BEGIN");
      try {
        const results: unknown[] = [];
        for (const stmt of stmts) results.push(await (stmt as Promise<unknown>));
        sqlite.exec("COMMIT");
        return results;
      } catch (err) {
        sqlite.exec("ROLLBACK");
        throw err;
      }
    };
    harness.db = made.db;
    sqlite
      .prepare("INSERT INTO accounts (id, name, created_at) VALUES ('acc_1', 'Acme', 1000)")
      .run();
    sqlite
      .prepare(
        "INSERT INTO stripe_connections (id, account_id, stripe_user_id, is_primary, connected_at, created_at) VALUES ('conn_1', 'acc_1', 'acct_s', 1, 1000, 1000)",
      )
      .run();
    sqlite.exec(
      "CREATE TRIGGER audit_down BEFORE INSERT ON admin_audit_log BEGIN SELECT RAISE(ABORT, 'audit down'); END;",
    );
  });
  it.each([
    ["billing exemption", { intent: "toggle-billing-exempt", nextExempt: "true" }],
    ["pause", { intent: "toggle-processing-paused", nextPaused: "true" }],
    ["cancel", { intent: "cancel", accountId: "acc_1", confirm: "cancel" }, merchantsAction],
  ])("%s: a failed audit write changes nothing", async (_name, fields, act?: unknown) => {
    await expect(postMerchant(fields, act)).rejects.toThrow();
    expect(accountRow()).toEqual({ exempt: 0, paused: 0, canceled: null });
    expect(sqlite.prepare("SELECT disconnected_at AS d FROM stripe_connections").get()).toEqual({
      d: null,
    });
  });
});

describe("the merchant page cannot cancel without the typed word", () => {
  it("a bare intent=cancel post to the merchant page cancels nothing", async () => {
    const made = createInMemoryDb();
    sqlite = made.sqlite;
    harness.db = made.db;
    sqlite
      .prepare("INSERT INTO accounts (id, name, created_at) VALUES ('acc_1', 'Acme', 1000)")
      .run();
    await postMerchant({ intent: "cancel" });
    expect(accountRow()).toEqual({ exempt: 0, paused: 0, canceled: null });
  });
});
