import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";

import { createInMemoryDb } from "./helpers/inmemory-db";

// A posted digest_email writes nothing: the notifications action no longer names the column.

const harness = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const { action } = await import("~/routes/app/settings/notifications");

const ACCOUNT = "acct_1";

let sqlite: Database.Database;
let db: ReturnType<typeof createInMemoryDb>["db"];

beforeEach(() => {
  ({ sqlite, db } = createInMemoryDb());
  harness.db = db;
  sqlite
    .prepare(
      "INSERT INTO accounts (id, name, created_at, notification_email, digest_email) VALUES (?, 'Acme', 1000, 'ops@acme.test', 'digest@acme.test')",
    )
    .run(ACCOUNT);
});

const ctx = {
  get(key: unknown) {
    if (key === cloudflareContext) return { env: {} as Env, ctx: {} as ExecutionContext };
    if (key === authContext) {
      return {
        userId: "user_1",
        userName: "Owner",
        email: "owner@acme.test",
        membership: { memberId: "m1", accountId: ACCOUNT, accountName: "Acme", role: "owner" },
        memberships: [{ memberId: "m1", accountId: ACCOUNT, accountName: "Acme", role: "owner" }],
        activeAccountId: ACCOUNT,
        isAdmin: false,
        isDemo: false,
        demoSignedIn: false,
      };
    }
    throw new Error("unexpected context key");
  },
} as unknown as Parameters<typeof action>[0]["context"];

async function post(fields: Record<string, string>): Promise<number> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const res = (await action({
    context: ctx,
    request: new Request("https://foxhoundapp.test/settings", { method: "POST", body: form }),
    params: {},
  } as never)) as unknown as { init?: { status?: number } };
  return res.init?.status ?? 200;
}

function accountRow(): { notificationEmail: string | null; digestEmail: string | null } {
  return sqlite
    .prepare(
      "SELECT notification_email AS notificationEmail, digest_email AS digestEmail FROM accounts WHERE id = ?",
    )
    .get(ACCOUNT) as { notificationEmail: string | null; digestEmail: string | null };
}

describe("a posted digest_email", () => {
  it("the notification email saves and digest_email is untouched", async () => {
    const status = await post({
      notificationEmail: "new@acme.test",
      digestEmail: "hijacked@evil.test",
      digest_email: "hijacked@evil.test",
    });

    expect(status).toBe(200);
    const row = accountRow();
    expect(row.notificationEmail).toBe("new@acme.test");
    expect(row.digestEmail).toBe("digest@acme.test");
  });
});
