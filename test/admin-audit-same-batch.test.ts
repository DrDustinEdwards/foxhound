import type Database from "better-sqlite3";
import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { adminContext } from "~/lib/admin/context";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";

import { createInMemoryDb, inMemoryMoneyWriter } from "./helpers/inmemory-db";

// Mythos billing review, finding 7: the merchant page ran the exemption, pause
// and cancel, then wrote the audit row. A failed audit write left the change
// standing with no record. Each now commits with its audit row in one batch,
// so with the audit table refusing inserts, nothing changes.

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));
vi.mock("~/lib/stripe/connect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/stripe/connect")>()),
  deauthorizeConnectedAccount: async () => ({ ok: true }),
}));

const { action } = await import("~/routes/admin/merchants/detail");

let sqlite: Database.Database;

beforeEach(() => {
  const made = createInMemoryDb();
  sqlite = made.sqlite;
  // D1 runs a batch as one transaction; the shared shim does not, so this one does.
  (made.db as unknown as { batch: (s: unknown[]) => Promise<unknown[]> }).batch = async (stmts) => {
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

function post(fields: Record<string, string>) {
  const c = new RouterContextProvider();
  c.set(cloudflareContext, {
    env: { MONEY_WRITER: inMemoryMoneyWriter(() => sqlite).binding } as unknown as Env,
    ctx: {} as ExecutionContext,
  });
  c.set(adminContext, { email: "admin@example.com" });
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.append(k, v);
  return (action as (args: unknown) => Promise<unknown>)({
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
  it.each([
    ["billing exemption", { intent: "toggle-billing-exempt", nextExempt: "true" }],
    ["pause", { intent: "toggle-processing-paused", nextPaused: "true" }],
    ["cancel", { intent: "cancel" }],
  ])("%s: a failed audit write changes nothing", async (_name, fields) => {
    await expect(post(fields)).rejects.toThrow();
    expect(accountRow()).toEqual({ exempt: 0, paused: 0, canceled: null });
    expect(sqlite.prepare("SELECT disconnected_at AS d FROM stripe_connections").get()).toEqual({
      d: null,
    });
  });
});
