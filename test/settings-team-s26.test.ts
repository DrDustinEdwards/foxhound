
import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";

import { createInMemoryDb } from "./helpers/inmemory-db";

// S26, /settings/team: member removal and the Pending pill.
//
// Legacy DELETES the account_members row (api/team/remove, blob 3fd92550) and
// refuses three ways: the target must be on the caller's account, an owner is
// never removable, and only an owner may ask. The route's old comment said
// removal was unbuildable "because account_members has no status beyond
// active/pending to represent it"; legacy never used a status for it.

const harness = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const { action, loader } = await import("~/routes/app/settings/team");

const OWNER = "user_owner";
const MEMBER_USER = "user_member";
const ACCOUNT = "acct_1";
const OTHER = "acct_other";

let sqlite: Database.Database;
let db: ReturnType<typeof createInMemoryDb>["db"];

beforeEach(() => {
  ({ sqlite, db } = createInMemoryDb());
  harness.db = db;
  for (const [id, email] of [
    [OWNER, "owner@acme.test"],
    [MEMBER_USER, "member@acme.test"],
  ] as const) {
    sqlite
      .prepare("INSERT INTO user (id, name, email, email_verified, updated_at) VALUES (?, ?, ?, 0, 0)")
      .run(id, email, email);
  }
  sqlite.prepare("INSERT INTO accounts (id, name, created_at) VALUES (?, ?, 1000)").run(ACCOUNT, "Acme");
  sqlite.prepare("INSERT INTO accounts (id, name, created_at) VALUES (?, ?, 1000)").run(OTHER, "Other");
  seedMember("m_owner", ACCOUNT, OWNER, "owner", "active");
});

function seedMember(
  id: string,
  accountId: string,
  userId: string | null,
  role: string,
  status: string,
  invitedEmail: string | null = null,
): void {
  sqlite
    .prepare(
      "INSERT INTO account_members (id, account_id, user_id, role, status, invited_email, created_at) VALUES (?, ?, ?, ?, ?, ?, 1000)",
    )
    .run(id, accountId, userId, role, status, invitedEmail);
}

function memberIds(accountId: string): string[] {
  return (
    sqlite.prepare("SELECT id FROM account_members WHERE account_id = ? ORDER BY id").all(accountId) as {
      id: string;
    }[]
  ).map((r) => r.id);
}

function ctxFor(role: string) {
  return {
    get(key: unknown) {
      if (key === cloudflareContext) return { env: {} as Env, ctx: {} as ExecutionContext, nonce: "n" };
      if (key === authContext) {
        return {
          userId: OWNER,
          userName: "Owner",
          email: "owner@acme.test",
          membership: { memberId: "m_owner", accountId: ACCOUNT, accountName: "Acme", role },
          memberships: [{ memberId: "m_owner", accountId: ACCOUNT, accountName: "Acme", role }],
          activeAccountId: ACCOUNT,
          isAdmin: false,
          isDemo: false,
          demoSignedIn: false,
        };
      }
      throw new Error("unexpected context key");
    },
  } as unknown as Parameters<typeof action>[0]["context"];
}

async function post(
  fields: Record<string, string>,
  role = "owner",
): Promise<{ status: number; body: Record<string, unknown> }> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const res = (await action({
    context: ctxFor(role),
    request: new Request("https://foxhoundapp.test/settings/team", { method: "POST", body: form }),
    params: {},
  } as never)) as unknown as { data: Record<string, unknown>; init?: { status?: number } };
  return { status: res.init?.status ?? 200, body: res.data };
}

describe("PLANT 1: remove deletes exactly the named membership", () => {
  it("removes a member of THIS account and leaves the others standing", async () => {
    seedMember("m_a", ACCOUNT, MEMBER_USER, "member", "active");
    seedMember("m_b", ACCOUNT, null, "member", "pending", "pending@acme.test");

    const res = await post({ _action: "remove", memberId: "m_a" });

    expect(res.status).toBe(200);
    expect(memberIds(ACCOUNT)).toEqual(["m_b", "m_owner"]);
  });
});

describe("PLANT 2: the three refusals legacy enforces", () => {
  it("403 and NO delete for a member on ANOTHER account", async () => {
    seedMember("m_theirs", OTHER, MEMBER_USER, "member", "active");

    const res = await post({ _action: "remove", memberId: "m_theirs" });

    expect(res.status).toBe(403);
    expect(memberIds(OTHER)).toEqual(["m_theirs"]);
  });

  it("403 and NO delete for an OWNER, which is also what blocks self-removal", async () => {
    const res = await post({ _action: "remove", memberId: "m_owner" });

    expect(res.status).toBe(403);
    expect(String(res.body.error)).toContain("owner cannot be removed");
    expect(memberIds(ACCOUNT)).toEqual(["m_owner"]);
  });

  it("403 and NO delete when the caller is not an owner", async () => {
    seedMember("m_a", ACCOUNT, MEMBER_USER, "member", "active");

    const res = await post({ _action: "remove", memberId: "m_a" }, "member");

    expect(res.status).toBe(403);
    expect(memberIds(ACCOUNT)).toEqual(["m_a", "m_owner"]);
  });

  it("400 and NO delete when no member id is sent", async () => {
    seedMember("m_a", ACCOUNT, MEMBER_USER, "member", "active");
    const res = await post({ _action: "remove" });
    expect(res.status).toBe(400);
    expect(memberIds(ACCOUNT)).toEqual(["m_a", "m_owner"]);
  });
});

describe("PLANT 3: inviting still works and is unchanged", () => {
  it("a post with no intent is still an invite, so the existing form keeps working", async () => {
    const res = await post({ email: "new@acme.test" });
    expect(res.status).toBe(200);
    expect(res.body.invited).toBe("new@acme.test");
    expect(String(res.body.inviteUrl)).toContain("/invite/");
  });

  it("the loader resolves removability per member, and never for the caller or an owner", async () => {
    seedMember("m_a", ACCOUNT, MEMBER_USER, "member", "active");
    const loaded = (await loader({
      context: ctxFor("owner"),
      request: new Request("https://x/settings/team"),
      params: {},
    } as never)) as { isOwner: boolean; members: { id: string; removable: boolean }[] };

    expect(loaded.isOwner).toBe(true);
    const byId = Object.fromEntries(loaded.members.map((m) => [m.id, m.removable]));
    expect(byId["m_a"]).toBe(true);
    // The caller's own row IS the owner row, so both refusals cover it.
    expect(byId["m_owner"]).toBe(false);
  });

  it("a non-owner caller can remove nobody", async () => {
    seedMember("m_a", ACCOUNT, MEMBER_USER, "member", "active");
    const loaded = (await loader({
      context: ctxFor("member"),
      request: new Request("https://x/settings/team"),
      params: {},
    } as never)) as { members: { removable: boolean }[] };
    expect(loaded.members.every((m) => !m.removable)).toBe(true);
  });
});
