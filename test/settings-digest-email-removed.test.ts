
import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";

import { createInMemoryDb } from "./helpers/inmemory-db";

// JOB 3 / ruling 336 binding 3. `digest_email` is a Foxhound invention: legacy
// has no such column, no such field, and no reader, and Foxhound's own audit
// digest sends to `notification_email`. It was rendered on /settings, so it was
// a false promise twice over, a field nothing reads AND a control legacy never
// had.
//
// The COLUMN stays. Dropping it is a migration and none is owed here, which is
// exactly why the plant below asserts the WRITE is gone rather than the column.

const harness = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

// SESSION 59 MOVED THE SUBJECT, NOT THE PROPERTY. The Email card this suite
// pinned lived on the /settings index; session 56 gave `notification_email` a
// purpose-built page and session 59 removed the card, which was a SECOND writer
// for one column. 336 binding 3's property is unchanged and is asserted at the
// surface that now owns the column.
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
    if (key === cloudflareContext) return { env: {} as Env, ctx: {} as ExecutionContext, nonce: "n" };
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

describe("PLANT 1: a posted digest_email writes nothing", () => {
  it("the notification email saves and digest_email is untouched", async () => {
    const status = await post({
      notificationEmail: "new@acme.test",
      digestEmail: "hijacked@evil.test",
      digest_email: "hijacked@evil.test",
    });

    expect(status).toBe(200);
    const row = accountRow();
    expect(row.notificationEmail).toBe("new@acme.test");
    // The pre-existing value stands: the allowlist no longer names the column,
    // so the post neither writes nor CLEARS it.
    expect(row.digestEmail).toBe("digest@acme.test");
  });
});
