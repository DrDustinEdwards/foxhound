import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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

  it("an empty notification email still nulls, so the removal narrowed nothing else", async () => {
    await post({ notificationEmail: "" });
    expect(accountRow().notificationEmail).toBeNull();
  });
});

describe("PLANT 2: the field does not render", () => {
  const SOURCE = readFileSync(
    fileURLToPath(new URL("../app/routes/app/settings/notifications.tsx", import.meta.url)),
    "utf8",
  );
  const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("no digest email input and no digest email label", () => {
    expect(code).not.toContain('name="digestEmail"');
    expect(code).not.toContain("Digest email");
  });

  it("THE PAGE IS THE ONLY WRITER OF notification_email", () => {
    // The /settings index carried an Email card writing the same column until
    // session 59 removed it. Two surfaces writing one column means the later
    // save wins silently, which is why the card went rather than being moved.
    const writers = execSync('git grep -l notificationEmail -- app/routes || true', {
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .filter(Boolean)
      .sort();
    expect(writers).toEqual(["app/routes/app/settings/notifications.tsx"]);
  });

  it("the notification email field is still there", () => {
    expect(code).toContain('name="notificationEmail"');
  });
});

describe("PLANT 3: the writer no longer names the column", () => {
  it("buildEmailSettingsUpdate takes one address and emits one column", () => {
    const persist = readFileSync(
      fileURLToPath(new URL("../app/lib/settings/persist.server.ts", import.meta.url)),
      "utf8",
    );
    const code = persist.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toContain("digestEmail");
  });
});
