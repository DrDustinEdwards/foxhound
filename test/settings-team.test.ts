import { sha256Hex } from "@dustinedwards/site-runtime/encoding";
import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";

import { createInMemoryDb } from "./helpers/inmemory-db";

interface SentMessage {
  from: string;
  to: string;
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
}

const harness = vi.hoisted(() => ({ db: null as unknown, sent: [] as SentMessage[] }));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const { action } = await import("~/routes/app/settings/team");
const { EMAIL_FROM_ADDRESS } = await import("~/lib/email/constants");
const { hashRecipient } = await import("~/lib/email/dispatch");

const BASE = "https://foxhoundapp.test";
const ACCOUNT = "acct_1";
const OTHER = "acct_other";
const OWNER = "user_owner";
const MEMBER_USER = "user_member";
const INVITEE = "new.person@example.com";

function makeEnv(over: Record<string, unknown> = {}): Env {
  return {
    ENCRYPTION_KEY: "ab".repeat(32),
    BETTER_AUTH_URL: BASE,
    PHYSICAL_ADDRESS: "1 Test Way, Austin TX",
    EMAIL: {
      send: async (m: SentMessage) => {
        harness.sent.push(m);
        return { id: "msg_1" };
      },
    },
    ...over,
  } as unknown as Env;
}

let env = makeEnv();
let sqlite: Database.Database;
let accountName = "Acme";

beforeEach(() => {
  const made = createInMemoryDb();
  sqlite = made.sqlite;
  harness.db = made.db;
  harness.sent = [];
  env = makeEnv();
  accountName = "Acme";
  for (const [id, email] of [
    [OWNER, "owner@acme.test"],
    [MEMBER_USER, "member@acme.test"],
  ]) {
    sqlite
      .prepare(
        "INSERT INTO user (id, name, email, email_verified, updated_at) VALUES (?, ?, ?, 0, 0)",
      )
      .run(id, email, email);
  }
  // Live sends are off, the default: an invite must not depend on them.
  for (const [id, name] of [
    [ACCOUNT, "Acme"],
    [OTHER, "Other"],
  ]) {
    sqlite
      .prepare(
        "INSERT INTO accounts (id, name, created_at, live_sends_enabled) VALUES (?, ?, 1000, 0)",
      )
      .run(id, name);
  }
  seedMember("m_owner", ACCOUNT, OWNER, "owner", "active");
});

function seedMember(
  id: string,
  accountId: string,
  userId: string | null,
  role: string,
  status: string,
  invitedEmail: string | null = null,
  createdAt: number | null = 1000,
): void {
  sqlite
    .prepare(
      "INSERT INTO account_members (id, account_id, user_id, role, status, invited_email, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(id, accountId, userId, role, status, invitedEmail, createdAt);
}

function memberIds(accountId: string): string[] {
  return (
    sqlite
      .prepare("SELECT id FROM account_members WHERE account_id = ? ORDER BY id")
      .all(accountId) as { id: string }[]
  ).map((r) => r.id);
}

function ctxFor(role = "owner") {
  return {
    get(key: unknown) {
      if (key === cloudflareContext) return { env, ctx: {} as ExecutionContext };
      if (key === authContext) {
        const membership = { memberId: "m_owner", accountId: ACCOUNT, accountName, role };
        return {
          userId: OWNER,
          userName: "Owner",
          email: "owner@acme.test",
          membership,
          memberships: [membership],
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
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const res = (await action({
    context: ctxFor(role),
    request: new Request(`${BASE}/settings/team`, { method: "POST", body: form, headers }),
    params: {},
  } as never)) as unknown as { data: Record<string, unknown>; init?: { status?: number } };
  return { status: res.init?.status ?? 200, body: res.data };
}

const invite = (email = INVITEE) => post({ email });

const only = (): SentMessage => {
  expect(harness.sent).toHaveLength(1);
  return harness.sent[0];
};

function storedInviteHash(): string {
  return (
    sqlite
      .prepare("SELECT invite_token AS t FROM account_members WHERE status = 'pending'")
      .get() as { t: string }
  ).t;
}

/** The token in an answer's invite link, checked against the pending row's hash. */
async function linkToken(body: Record<string, unknown>): Promise<string> {
  const token = String(body.inviteUrl).split(`${BASE}/invite/`)[1];
  expect(await sha256Hex(token)).toBe(storedInviteHash());
  return token;
}

function pendingCount(): number {
  return (
    sqlite.prepare("SELECT COUNT(*) AS n FROM account_members WHERE status = 'pending'").get() as {
      n: number;
    }
  ).n;
}

describe("removing a member", () => {
  it("removes a member of this account and leaves the others standing", async () => {
    seedMember("m_a", ACCOUNT, MEMBER_USER, "member", "active");
    seedMember("m_b", ACCOUNT, null, "member", "pending", "pending@acme.test");

    expect((await post({ _action: "remove", memberId: "m_a" })).status).toBe(200);
    expect(memberIds(ACCOUNT)).toEqual(["m_b", "m_owner"]);
  });

  it("403 and no delete for another account's member, an owner, or a caller who is not an owner", async () => {
    seedMember("m_theirs", OTHER, MEMBER_USER, "member", "active");
    seedMember("m_a", ACCOUNT, MEMBER_USER, "member", "active");

    expect((await post({ _action: "remove", memberId: "m_theirs" })).status).toBe(403);
    // The owner's own row is the owner row, so this also blocks self-removal.
    const owner = await post({ _action: "remove", memberId: "m_owner" });
    expect(owner.status).toBe(403);
    expect(String(owner.body.error)).toContain("owner cannot be removed");
    expect((await post({ _action: "remove", memberId: "m_a" }, "member")).status).toBe(403);

    expect(memberIds(OTHER)).toEqual(["m_theirs"]);
    expect(memberIds(ACCOUNT)).toEqual(["m_a", "m_owner"]);
  });
});

describe("inviting a teammate", () => {
  it("sends one email to the invited address, linking the pending invite, and answers with the link", async () => {
    const res = await invite();

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      error: null,
      invited: INVITEE,
      emailStatus: "sent",
      emailError: null,
    });
    const m = only();
    const url = `${BASE}/invite/${await linkToken(res.body)}`;
    expect(m.to).toBe(INVITEE);
    expect(m.html).toContain(url);
    expect(m.text).toContain(url);
    expect(m.from).toBe(`Foxhound <${EMAIL_FROM_ADDRESS}>`);
    expect(m.replyTo).toBeUndefined();
    expect(
      sqlite
        .prepare(
          "SELECT account_id AS a, template AS t, recipient_hash AS h, status AS s FROM email_sends",
        )
        .all(),
    ).toEqual([{ a: ACCOUNT, t: "team_invite", h: await hashRecipient(INVITEE), s: "sent" }]);
  });

  it("a non-owner, an empty address, or a removal sends nothing", async () => {
    await post({ email: INVITEE }, "member");
    await post({ email: "" });
    await post({ _action: "remove", memberId: "nobody" });
    expect(harness.sent).toHaveLength(0);
  });

  it("a team name is words, never markup", async () => {
    accountName = "Tom & Jerry <b>Co</b>";
    await invite();
    const m = only();
    expect(m.text).toContain("You've been invited to join Tom & Jerry <b>Co</b> on Foxhound.");
    expect(m.html).toContain("Tom &amp; Jerry &lt;b&gt;Co&lt;/b&gt;");
    expect(m.html).not.toContain("<b>Co</b>");
  });

  it("a send that is refused or fails still leaves the invite, and tells the merchant", async () => {
    sqlite
      .prepare(
        "INSERT INTO email_suppressions (id, email, token, reason, suppressed_at) VALUES ('s1', ?, 't', 'bounce', 2000)",
      )
      .run(INVITEE);
    const suppressed = await invite();
    expect(harness.sent).toHaveLength(0);
    expect(suppressed.status).toBe(200);
    expect(suppressed.body.emailStatus).toBe("suppressed");
    await linkToken(suppressed.body);

    for (const broken of [
      undefined,
      {
        send: async () => {
          throw new Error("provider said no");
        },
      },
    ]) {
      sqlite.prepare("DELETE FROM account_members WHERE status = 'pending'").run();
      sqlite.prepare("DELETE FROM email_suppressions").run();
      env = makeEnv({ EMAIL: broken });
      const res = await invite();
      expect(res.status).toBe(200);
      expect(res.body.emailStatus).toBe("failed");
      expect(String(res.body.emailError)).toMatch(/could not/i);
      expect(storedInviteHash()).toBeTruthy();
    }
  });

  it("the invite link never reaches email_sends.error", async () => {
    env = makeEnv({
      EMAIL: {
        send: async (m: SentMessage) => {
          const href = /href="([^"]*invite[^"]*)"/.exec(m.html)?.[1] ?? "";
          throw new Error(`rejected message linking ${href}`);
        },
      },
    });
    const res = await invite();
    const token = await linkToken(res.body);
    expect(res.body.emailStatus).toBe("failed");
    const row = sqlite.prepare("SELECT error FROM email_sends").get() as { error: string };
    expect(row.error).toContain("rejected message linking");
    expect(row.error).not.toContain(token);
    expect(row.error).toContain("[redacted]");
  });
});

describe("invite limits and checks", () => {
  interface LimiterCall {
    name: string;
    rules: Array<{ limit: number; windowSeconds: number }>;
  }

  function limiterEnv(allowed: boolean, calls: LimiterCall[]): Env {
    return makeEnv({
      RATE_LIMITER: {
        idFromName: (name: string) => name,
        get: (name: string) => ({
          hit: async (rules: LimiterCall["rules"]) => {
            calls.push({ name, rules });
            return { ok: allowed, retryAfterSeconds: 60 };
          },
        }),
      },
    });
  }

  it("5 invites an hour per IP: the bucket is checked, and over the limit it is 429 with nothing written or sent", async () => {
    const calls: LimiterCall[] = [];
    env = limiterEnv(true, calls);
    await post({ email: INVITEE }, "owner", { "cf-connecting-ip": "203.0.113.9" });
    expect(calls).toEqual([
      { name: "invite:203.0.113.9", rules: [{ limit: 5, windowSeconds: 60 * 60 }] },
    ]);
    expect(harness.sent).toHaveLength(1);

    harness.sent = [];
    sqlite.prepare("DELETE FROM account_members WHERE status = 'pending'").run();
    env = limiterEnv(false, []);
    const res = await invite();
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("Too many requests. Try again later.");
    expect(pendingCount()).toBe(0);
    expect(harness.sent).toHaveLength(0);
  });

  it("refuses a malformed or multi-recipient address before anything is written", async () => {
    for (const bad of [
      "not-an-email",
      "a@b",
      "a@example.com\nBcc: x@example.com",
      "a@example.com\r\nb@example.com",
      "a@example.com,b@example.com",
      "a@example.com;b@example.com",
      "a@example.com b@example.com",
      "Name <a@example.com>",
    ]) {
      const res = await invite(bad);
      expect(res.status, bad).toBe(400);
      expect(res.body.error).toBe("Invalid email address");
    }
    expect(pendingCount()).toBe(0);
    expect(harness.sent).toHaveLength(0);
  });

  describe("a repeat invite", () => {
    const DUP = "This email already has a pending or active membership";

    it("is refused for a pending address, whatever its case or spacing, and sends nothing more", async () => {
      await invite();
      for (const again of [INVITEE, "  New.Person@Example.COM "]) {
        const res = await invite(again);
        expect(res.status).toBe(409);
        expect(res.body.error).toBe(DUP);
      }
      expect(pendingCount()).toBe(1);
      expect(harness.sent).toHaveLength(1);
    });

    it("is refused for an active membership with that invited address", async () => {
      seedMember("m_act", ACCOUNT, null, "member", "active", INVITEE);
      expect((await invite()).status).toBe(409);
      expect(harness.sent).toHaveLength(0);
    });

    it("the same address pending on another account does not block this one", async () => {
      seedMember("m_x", OTHER, null, "member", "pending", INVITEE);
      expect((await invite()).status).toBe(200);
      expect(harness.sent).toHaveLength(1);
    });
  });
});
