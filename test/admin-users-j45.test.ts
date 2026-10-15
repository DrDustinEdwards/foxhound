import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { describe, expect, it } from "vitest";

import { accountMembers, accounts, session, user } from "~/db";

import { createInMemoryDb } from "./helpers/inmemory-db";

// J45 (job_e3ac5fdfcfdc, row D7): /admin/users on the family admin pattern
// (Capsomer patterns, Dustin's Q9 of 2026-10-14), with Recova's users page
// (app/admin/users/page.tsx, blob efd3620b) read as the inventory: email, last
// sign-in, joined, user ID and a count. Last sign-in comes from Foxhound's own
// engine (Better Auth's session table in D1). A user may belong to several
// accounts (RULES.md 1.6), so every membership shows, one person per row.

const UsersPage = (await import("~/routes/admin/users")).default;
// Looked up so a missing export fails the assertion that names it, not the
// whole file (RULES.md 6.5).
const serverLib: Record<string, unknown> = await import("~/lib/admin/users.server");
const pageLib: Record<string, unknown> = await import("~/lib/admin/page");

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const at = (msAgo: number) => new Date(NOW - msAgo);
const ENV = { ADMIN_EMAIL: "admin@example.com" } as unknown as Env;

interface Membership {
  accountId: string;
  accountName: string | null;
  role: string;
  status: string;
  inviteExpired: boolean;
}
interface UserRow {
  id: string;
  name: string;
  email: string;
  createdAt: Date;
  isAdmin: boolean;
  lastSignInAt: Date | null;
  memberships: Membership[];
}

async function list(db: unknown): Promise<UserRow[]> {
  expect(typeof serverLib.listPlatformUsers).toBe("function");
  return (serverLib.listPlatformUsers as (db: unknown, env: Env, nowMs: number) => Promise<UserRow[]>)(db, ENV, NOW);
}

async function seed() {
  const { db } = createInMemoryDb();
  await db.insert(user).values([
    // Invites are matched only to a verified email, so both people with one
    // are verified.
    { id: "u_rosa", name: "Rosa Park", email: "rosa@example.com", emailVerified: true, createdAt: at(30 * DAY), updatedAt: at(30 * DAY) },
    { id: "u_sam", name: "Sam Ortiz", email: "sam@example.com", emailVerified: true, createdAt: at(10 * DAY), updatedAt: at(10 * DAY) },
    { id: "u_admin", name: "Admin Person", email: "admin@example.com", createdAt: at(60 * DAY), updatedAt: at(60 * DAY) },
  ]);
  await db.insert(accounts).values([
    { id: "acct_north", name: "Northwind Coffee", createdAt: at(40 * DAY) },
    { id: "acct_lumen", name: "Lumen Studio", createdAt: at(20 * DAY) },
    { id: "acct_harbor", name: "Harbor Yoga", createdAt: at(20 * DAY) },
  ]);
  await db.insert(accountMembers).values([
    { id: "m1", accountId: "acct_north", userId: "u_rosa", role: "owner", status: "active", createdAt: at(30 * DAY) },
    { id: "m2", accountId: "acct_lumen", userId: "u_rosa", role: "member", status: "active", createdAt: at(20 * DAY) },
    // A pending invite has no user id yet: it is matched by the invited email.
    {
      id: "m3",
      accountId: "acct_harbor",
      userId: null,
      role: "member",
      invitedEmail: "rosa@example.com",
      status: "pending",
      inviteToken: "tok_1",
      inviteExpiresAt: at(-3 * DAY),
      createdAt: at(4 * DAY),
    },
    // An invite past its expiry, and one to an email with no user.
    {
      id: "m4",
      accountId: "acct_north",
      userId: null,
      role: "member",
      invitedEmail: "sam@example.com",
      status: "pending",
      inviteToken: "tok_2",
      inviteExpiresAt: at(2 * DAY),
      createdAt: at(9 * DAY),
    },
    {
      id: "m5",
      accountId: "acct_north",
      userId: null,
      role: "member",
      invitedEmail: "nobody@example.com",
      status: "pending",
      inviteToken: "tok_3",
      inviteExpiresAt: at(-3 * DAY),
      createdAt: at(1 * DAY),
    },
  ]);
  const sess = (id: string, userId: string, createdAt: Date) => ({
    id,
    userId,
    token: `token_${id}`,
    expiresAt: new Date(createdAt.getTime() + 7 * DAY),
    createdAt,
    updatedAt: createdAt,
  });
  await db.insert(session).values([
    sess("s1", "u_rosa", at(5 * DAY)),
    sess("s2", "u_rosa", at(2 * 60 * 60 * 1000)),
    sess("s3", "u_rosa", at(3 * DAY)),
    sess("s4", "u_admin", at(1 * DAY)),
  ]);
  return db;
}

describe("listPlatformUsers", () => {
  it("reads last sign-in as the newest session", async () => {
    const rows = await list(await seed());
    const rosa = rows.find((r) => r.id === "u_rosa");
    expect(rosa?.lastSignInAt?.getTime()).toBe(at(2 * 60 * 60 * 1000).getTime());
  });

  it("has no last sign-in for a user with no session", async () => {
    const rows = await list(await seed());
    expect(rows.find((r) => r.id === "u_sam")?.lastSignInAt).toBeNull();
  });

  it("returns one row per person, newest first", async () => {
    const rows = await list(await seed());
    expect(rows.map((r) => r.id)).toEqual(["u_sam", "u_rosa", "u_admin"]);
  });

  it("returns every account a user belongs to, active first, pending invites after", async () => {
    const rows = await list(await seed());
    const rosa = rows.find((r) => r.id === "u_rosa")!;
    expect(rosa.memberships.map((m) => [m.accountId, m.accountName, m.role, m.status])).toEqual([
      ["acct_lumen", "Lumen Studio", "member", "active"],
      ["acct_north", "Northwind Coffee", "owner", "active"],
      ["acct_harbor", "Harbor Yoga", "member", "pending"],
    ]);
    const sam = rows.find((r) => r.id === "u_sam")!;
    expect(sam.memberships).toEqual([
      { accountId: "acct_north", accountName: "Northwind Coffee", role: "member", status: "pending", inviteExpired: true },
    ]);
    expect(rows.find((r) => r.id === "u_admin")!.memberships).toEqual([]);
  });

  it("keeps the platform role from the admin allowlist", async () => {
    const rows = await list(await seed());
    expect(rows.find((r) => r.id === "u_admin")?.isAdmin).toBe(true);
    expect(rows.find((r) => r.id === "u_rosa")?.isAdmin).toBe(false);
  });
});

function render(users: UserRow[]): string {
  const Stub = createRoutesStub([
    {
      path: "/admin/users",
      Component: () => createElement(UsersPage as never, { loaderData: { users } } as never),
    },
  ]);
  return renderToStaticMarkup(createElement(Stub, { initialEntries: ["/admin/users"] }));
}

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replaceAll("&#x27;", "'")
    .replaceAll("&amp;", "&")
    .replace(/\s+/g, " ");

describe("the Users page", () => {
  it("shows one row per person, with every account and a pending invite marked invited", async () => {
    const html = render(await list(await seed()));
    const body = html.slice(html.indexOf("<tbody"));
    expect([...body.matchAll(/<tr[ >]/g)].length).toBe(3);
    const t = text(html);
    expect(t).toContain("Rosa Park");
    expect(t).toContain("rosa@example.com");
    expect(html).toMatch(/<a [^>]*href="\/admin\/merchants\/acct_north"[^>]*>Northwind Coffee<\/a>/);
    expect(html).toMatch(/<a [^>]*href="\/admin\/merchants\/acct_lumen"[^>]*>Lumen Studio<\/a>/);
    expect(t).toMatch(/Harbor Yoga\s*invited/);
    expect(t).toMatch(/Northwind Coffee\s*owner/);
    expect(t).toContain("invite expired");
  });

  it("says no sign-in on record for a user with no session, not never", async () => {
    const t = text(render(await list(await seed())));
    expect(t).toContain("No sign-in on record");
    expect(t).not.toMatch(/\bnever\b/);
  });

  it("says how many people in a plain sentence", async () => {
    expect(text(render(await list(await seed())))).toContain("3 people can sign in to Foxhound.");
    expect(text(render((await list(await seed())).slice(0, 1)))).toContain("1 person can sign in to Foxhound.");
  });

  it("has the columns in sentence case, a User ID column, scoped headers and a named region", async () => {
    const html = render(await list(await seed()));
    const headers = [...html.matchAll(/<th scope="col"[^>]*>([^<]*)</g)].map((m) => m[1]);
    expect(headers).toEqual(["Person", "Accounts", "Platform role", "Last sign-in", "Joined", "User ID"]);
    expect(html).toContain('class="cap-table"');
    expect(html).toMatch(/<caption[^>]*>/);
    expect(html).toMatch(/class="cap-table-wrap"[^>]*role="region"[^>]*aria-labelledby="[^"]+"[^>]*tabindex="0"/);
    expect(html).toMatch(/<th scope="row"/);
    expect(text(html)).toContain("u_rosa");
    expect(html).toMatch(/break-all/);
  });

  it("says so when there are no users, with Capsomer's empty state", () => {
    const html = render([]);
    expect(html).toContain("cap-empty");
    expect(text(html)).toContain("No users yet.");
    expect(html).not.toContain("<table");
  });

  it("writes in sentence case with Foxhound's text sizes and no amber", async () => {
    const html = render(await list(await seed()));
    expect(html).not.toMatch(/\buppercase\b/);
    expect(html).not.toMatch(/tracking-/);
    expect(html).not.toMatch(/text-\[/);
    expect(html).not.toMatch(/amber/i);
    const source = readFileSync(fileURLToPath(new URL("../app/routes/admin/users.tsx", import.meta.url)), "utf8");
    expect(source).not.toMatch(/text-\[/);
    expect(source).not.toMatch(/amber/i);
    expect(source).not.toMatch(/\buppercase\b/);
  });

  it("gives every link a 24 px target", async () => {
    const html = render(await list(await seed()));
    const links = [...html.matchAll(/<a [^>]*>/g)].map((m) => m[0]);
    expect(links.length).toBeGreaterThan(0);
    for (const a of links) expect(a).toMatch(/min-h-6/);
  });
});

const invite = (id: string, accountId: string, email: string, expiresAt: Date) => ({
  id,
  accountId,
  userId: null,
  role: "member",
  invitedEmail: email,
  status: "pending",
  inviteToken: `tok_${id}`,
  inviteExpiresAt: expiresAt,
  createdAt: at(5 * DAY),
});

describe("listPlatformUsers, invites (code review)", () => {
  async function seedInvites() {
    const { db } = createInMemoryDb();
    await db.insert(user).values([
      { id: "u_rosa", name: "Rosa Park", email: "rosa@example.com", emailVerified: true, createdAt: at(30 * DAY), updatedAt: at(30 * DAY) },
      { id: "u_eve", name: "Eve Unverified", email: "eve@example.com", emailVerified: false, createdAt: at(20 * DAY), updatedAt: at(20 * DAY) },
    ]);
    await db.insert(accounts).values([
      { id: "acct_north", name: "Northwind Coffee", createdAt: at(40 * DAY) },
      { id: "acct_harbor", name: "Harbor Yoga", createdAt: at(20 * DAY) },
    ]);
    await db.insert(accountMembers).values([
      { id: "m1", accountId: "acct_north", userId: "u_rosa", role: "owner", status: "active", createdAt: at(30 * DAY) },
      // Already an active member here: the invite says nothing more.
      invite("i1", "acct_north", "rosa@example.com", at(-3 * DAY)),
      // Two invites to one account: one row, the one that can still be accepted.
      invite("i2", "acct_harbor", "rosa@example.com", at(2 * DAY)),
      invite("i3", "acct_harbor", "rosa@example.com", at(-3 * DAY)),
      invite("i4", "acct_harbor", "rosa@example.com", at(1 * DAY)),
      // An unverified email is never matched to an invite.
      invite("i5", "acct_harbor", "eve@example.com", at(-3 * DAY)),
    ]);
    return db;
  }

  it("lists each account once per person and drops an invite to an account they are already in", async () => {
    const rows = await list(await seedInvites());
    const rosa = rows.find((r) => r.id === "u_rosa")!;
    expect(rosa.memberships).toEqual([
      { accountId: "acct_north", accountName: "Northwind Coffee", role: "owner", status: "active", inviteExpired: false },
      { accountId: "acct_harbor", accountName: "Harbor Yoga", role: "member", status: "pending", inviteExpired: false },
    ]);
  });

  it("matches invites only to a verified email", async () => {
    const rows = await list(await seedInvites());
    expect(rows.find((r) => r.id === "u_eve")!.memberships).toEqual([]);
  });
});

describe("pagePending (shared by the admin pages)", () => {
  it("treats a trailing slash as the same page", () => {
    expect(typeof pageLib.pagePending).toBe("function");
    const pending = pageLib.pagePending as (
      nav: { state: string; location?: { pathname: string } },
      r: string,
      pathname: string,
    ) => boolean;
    expect(pending({ state: "loading", location: { pathname: "/admin/users/" } }, "idle", "/admin/users")).toBe(true);
    expect(pending({ state: "loading", location: { pathname: "/admin/" } }, "idle", "/admin")).toBe(true);
    expect(pending({ state: "loading", location: { pathname: "/admin/users" } }, "idle", "/admin")).toBe(false);
    expect(pending({ state: "idle" }, "loading", "/admin/users")).toBe(true);
  });
});

describe("merchantHref (one helper)", () => {
  it("is exported once and used by the overview, the users page and the audit log", () => {
    expect(typeof pageLib.merchantHref).toBe("function");
    expect((pageLib.merchantHref as (id: string) => string)("acct a")).toBe("/admin/merchants/acct%20a");
    for (const f of ["overview.ts", "users.ts", "audit-describe.ts"]) {
      const src = readFileSync(fileURLToPath(new URL(`../app/lib/admin/${f}`, import.meta.url)), "utf8");
      expect(src, f).not.toContain("`/admin/merchants/${");
    }
  });
});

describe("the Users page's pending state", () => {
  it("is pending while the Users page's own data is read again, not while leaving it", () => {
    // usersPending became the shared pagePending (code review).
    expect(typeof pageLib.pagePending).toBe("function");
    const shared = pageLib.pagePending as (nav: { state: string; location?: { pathname: string } }, r: string, p: string) => boolean;
    const pending = (nav: { state: string; location?: { pathname: string } }, r: string) => shared(nav, r, "/admin/users");
    expect(pending({ state: "idle" }, "loading")).toBe(true);
    expect(pending({ state: "loading", location: { pathname: "/admin/users" } }, "idle")).toBe(true);
    expect(pending({ state: "loading", location: { pathname: "/admin" } }, "idle")).toBe(false);
    expect(pending({ state: "idle" }, "idle")).toBe(false);
  });
});
