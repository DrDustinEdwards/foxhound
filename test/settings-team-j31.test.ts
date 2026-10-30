import type Database from "better-sqlite3";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";

import { createInMemoryDb } from "./helpers/inmemory-db";

// J31, row S26: /settings/team against Recova's page.
//
// Recova is the spec for content, layout and features: app/(app)/settings/team/page.tsx
// (blob 09983bed, 1765 bytes) and app/(app)/settings/components/TeamSection.tsx
// (blob ab19f9de, 6414 bytes), read whole. Top to bottom: the phone-only
// "Settings" back link, the heading "Team" and its line, then ONE card with
// the member rows (owner first) and, for an owner, the invite form under a
// rule: "Invite a team member", the email input and "Send invite" on one row,
// the result line under them. The parts are Capsomer's, amber,
// on the five text sizes.
//
// The server rules (owner only, same account, owner never removable) are
// test/settings-team-s26.test.ts. These read the RENDERED page.

const harness = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const route = await import("~/routes/app/settings/team");
const { pendingState, shouldClearInvite } = await import("~/lib/settings/team-page");
const Team = route.default;

type Props = Parameters<typeof Team>[0];
type LoaderData = Props["loaderData"];
type ActionData = Props["actionData"];

function render(loaderData: LoaderData, actionData?: ActionData, url = "/settings/team"): string {
  const props = { loaderData, actionData, params: {}, matches: [] } as unknown as Props;
  const router = createMemoryRouter([{ path: "*", element: createElement(Team, props) }], {
    initialEntries: [url],
  });
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}

/** Visible text, tags stripped and whitespace collapsed, for order checks. */
function text(html: string): string {
  return html
    .replace(/<span class="sr-only">[^<]*<\/span>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

type Member = LoaderData["members"][number];

// No casts on the fixtures, so tsc checks them against the loader's real shape.
function member(over: Partial<Member>): Member {
  const base: Member = {
    id: "m_x",
    userId: "u_x",
    userName: "Someone",
    userEmail: "someone@example.com",
    invitedEmail: null,
    role: "member",
    status: "active",
    removable: false,
    isOwnerRole: false,
  };
  // isOwnerRole is resolved in the loader, as the page reads it.
  return { ...base, ...over, isOwnerRole: (over.role ?? base.role) === "owner" };
}

const OWNER_ROW = member({ id: "m_owner", userId: "u_owner", userName: "Dana Owner", userEmail: "dana@example.com", role: "owner" });
const MEMBER_ROW = member({ id: "m_sam", userId: "u_sam", userName: "Sam Member", userEmail: "sam@example.com", removable: true });
const PENDING_ROW = member({
  id: "m_pend",
  userId: null,
  userName: null,
  userEmail: null,
  invitedEmail: "new@example.com",
  status: "pending",
  removable: true,
});

const AS_OWNER: LoaderData = {
  isOwner: true,
  members: [OWNER_ROW, MEMBER_ROW, PENDING_ROW],
};
const AS_MEMBER: LoaderData = {
  isOwner: false,
  members: [OWNER_ROW, { ...MEMBER_ROW, removable: false }, { ...PENDING_ROW, removable: false }],
};

const INVITE_OK: ActionData = {
  action: "invite",
  error: null,
  invited: "new@example.com",
  inviteUrl: "https://foxhoundapp.test/invite/tok",
  memberId: null,
  emailStatus: "sent",
  emailError: null,
};
const INVITE_BAD: ActionData = {
  action: "invite",
  error: "Enter an email address to invite.",
  invited: null,
  inviteUrl: null,
  memberId: null,
};

describe("J31: the member rows", () => {
  it("an empty name falls through to the email, as Recova's || does", () => {
    const html = render({ ...AS_OWNER, members: [OWNER_ROW, { ...MEMBER_ROW, userName: "" }] });
    expect(text(html)).toContain("sam@example.com");
  });

  it("an owner gets a Remove member link on each removable row only", () => {
    const html = render(AS_OWNER);
    const links = [...html.matchAll(/<a[^>]*href="\?confirm=([^"]+)"[^>]*>/g)];
    expect(links.map((m) => m[1])).toEqual(["m_sam", "m_pend"]);
  });

  it("the confirm posts the named member", () => {
    const html = render(AS_OWNER, undefined, "/settings/team?confirm=m_sam");
    expect(html).toContain('name="memberId" value="m_sam"');
  });

  it("a member viewer sees the list and nothing to change", () => {
    const html = render(AS_MEMBER);
    expect(html).not.toContain("?confirm=");
    expect(html).not.toContain("Invite a team member");
    expect(html).not.toMatch(/<form/);
  });
});

describe("J31: the invite form", () => {
  it("the invite form names its own action, so pending and results can tell the forms apart", () => {
    const html = render(AS_OWNER);
    const form = html.slice(html.lastIndexOf("<form"));
    expect(form).toContain('<input type="hidden" name="_action" value="invite"/>');
  });
});

describe("J31: pending and clearing belong to the form that was sent", () => {
  function fd(fields: Record<string, string>): FormData {
    const f = new FormData();
    for (const [k, v] of Object.entries(fields)) f.append(k, v);
    return f;
  }

  it("a remove in flight marks only its row, never the invite button", () => {
    expect(pendingState(fd({ _action: "remove", memberId: "m_sam" }))).toEqual({ invite: false, removing: "m_sam" });
  });

  it("an invite in flight marks only the invite button", () => {
    expect(pendingState(fd({ _action: "invite", email: "a@example.com" }))).toEqual({ invite: true, removing: null });
  });

  it("nothing in flight, nothing pending", () => {
    expect(pendingState(undefined)).toEqual({ invite: false, removing: null });
  });

  it("only a sent invite clears the field; a remove result keeps a half-typed address", () => {
    expect(shouldClearInvite(INVITE_OK)).toBe(true);
    expect(shouldClearInvite(INVITE_BAD)).toBe(false);
    expect(shouldClearInvite({ action: "remove", error: null, invited: null, inviteUrl: null, memberId: "m_sam" })).toBe(false);
    expect(
      shouldClearInvite({ action: "remove", error: "No.", invited: null, inviteUrl: null, memberId: "m_sam" }),
    ).toBe(false);
    expect(shouldClearInvite(undefined)).toBe(false);
  });
});

describe("J31: the loader lists the owner first", () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    let db: unknown;
    ({ sqlite, db } = createInMemoryDb());
    harness.db = db;
    for (const id of ["u_a", "u_b", "u_owner"]) {
      sqlite
        .prepare("INSERT INTO user (id, name, email, email_verified, updated_at) VALUES (?, ?, ?, 0, 0)")
        .run(id, id, `${id}@example.com`);
    }
    sqlite.prepare("INSERT INTO accounts (id, name, created_at) VALUES ('acct', 'Acme', 1000)").run();
    // The owner joined LAST, so insertion order alone would list them last.
    const add = sqlite.prepare(
      "INSERT INTO account_members (id, account_id, user_id, role, status, created_at) VALUES (?, 'acct', ?, ?, 'active', ?)",
    );
    add.run("m_a", "u_a", "member", 1000);
    add.run("m_b", "u_b", "member", 2000);
    add.run("m_owner", "u_owner", "owner", 3000);
    // created_at is nullable on account_members (app/db/schema.ts). SQLite
    // sorts NULL first in ascending order; a row with no time goes last.
    sqlite
      .prepare("INSERT INTO user (id, name, email, email_verified, updated_at) VALUES ('u_c', 'u_c', 'u_c@example.com', 0, 0)")
      .run();
    add.run("m_null", "u_c", "member", null);
  });

  it("owner first, then the rest in the order they joined, a row with no join time last", async () => {
    const ctx = {
      get(key: unknown) {
        if (key === cloudflareContext) return { env: {} as Env, ctx: {} as ExecutionContext, nonce: "n" };
        if (key === authContext) {
          const m = { memberId: "m_owner", accountId: "acct", accountName: "Acme", role: "owner" };
          return { userId: "u_owner", email: "u_owner@example.com", membership: m, memberships: [m] };
        }
        throw new Error("unexpected context key");
      },
    };
    const loaded = (await route.loader({ context: ctx, request: new Request("https://x/settings/team"), params: {} } as never)) as {
      members: { id: string }[];
    };
    expect(loaded.members.map((m) => m.id)).toEqual(["m_owner", "m_a", "m_b", "m_null"]);
  });

  it("the action says which form it answers, and a remove result names its row", async () => {
    const ctx = {
      get(key: unknown) {
        if (key === cloudflareContext) return { env: {} as Env, ctx: {} as ExecutionContext, nonce: "n" };
        if (key === authContext) {
          const m = { memberId: "m_owner", accountId: "acct", accountName: "Acme", role: "owner" };
          return { userId: "u_owner", email: "u_owner@example.com", membership: m, memberships: [m] };
        }
        throw new Error("unexpected context key");
      },
    };
    async function post(fields: Record<string, string>) {
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) form.append(k, v);
      const res = (await route.action({
        context: ctx,
        request: new Request("https://x/settings/team", { method: "POST", body: form }),
        params: {},
      } as never)) as unknown as { data: Record<string, unknown> };
      return res.data;
    }
    expect(await post({ _action: "remove", memberId: "m_owner" })).toMatchObject({ action: "remove", memberId: "m_owner" });
    expect(await post({ _action: "remove", memberId: "m_a" })).toMatchObject({ action: "remove", error: null, memberId: "m_a" });
    expect(await post({ _action: "invite", email: "" })).toMatchObject({ action: "invite", memberId: null });
  });
});
