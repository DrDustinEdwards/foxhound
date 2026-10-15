import type Database from "better-sqlite3";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";

import { createInMemoryDb } from "./helpers/inmemory-db";

// J31 (job_8d030f93c15f), row S26: /settings/team against Recova's page.
//
// Recova is the spec for content, layout and features: app/(app)/settings/team/page.tsx
// (blob 09983bed, 1765 bytes) and app/(app)/settings/components/TeamSection.tsx
// (blob ab19f9de, 6414 bytes), read whole. Top to bottom: the phone-only
// "Settings" back link, the heading "Team" and its line, then ONE card with
// the member rows (owner first) and, for an owner, the invite form under a
// rule: "Invite a team member", the email input and "Send invite" on one row,
// the result line under them. The parts are Capsomer's (Q10, Q12), teal (Q11),
// on the five text sizes (RULES.md 5.2).
//
// The server rules (owner only, same account, owner never removable) are
// test/settings-team-s26.test.ts. These read the RENDERED page.

const harness = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const route = await import("~/routes/app/settings/team");
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

/** Assert each needle appears, in this order. */
function inOrder(haystack: string, needles: string[]) {
  let from = -1;
  for (const n of needles) {
    const i = haystack.indexOf(n, from + 1);
    expect(i, `"${n}" appears after the item before it`).toBeGreaterThan(from);
    from = i;
  }
}

const NOT_A_SIZE =
  /^text-(text|text-secondary|text-tertiary|text-subtle|accent-text|accent-hover|error-text|success-text|on-brand|brand-text|chrome-text|chrome-text-secondary|red|green|left|right|center)$/;

function sizeClasses(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/class="([^"]*)"/g)) {
    for (const c of m[1].split(/\s+/)) {
      const base = c.replace(/^[a-z0-9-]+:/g, "");
      if (base.startsWith("text-") && !NOT_A_SIZE.test(base)) out.push(base);
    }
  }
  return out;
}

type Member = LoaderData["members"][number];

function member(over: Partial<Member>): Member {
  return {
    id: "m_x",
    userId: "u_x",
    userName: "Someone",
    userEmail: "someone@example.com",
    invitedEmail: null,
    role: "member",
    status: "active",
    removable: false,
    ...over,
    // Resolved in the loader, as the page reads it.
    isOwnerRole: (over.role ?? "member") === "owner",
  } as Member;
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

const AS_OWNER = {
  accountName: "Acme Supply Co.",
  isOwner: true,
  members: [OWNER_ROW, MEMBER_ROW, PENDING_ROW],
} as unknown as LoaderData;
const AS_MEMBER = {
  ...AS_OWNER,
  isOwner: false,
  members: [OWNER_ROW, { ...MEMBER_ROW, removable: false }, { ...PENDING_ROW, removable: false }],
} as unknown as LoaderData;

describe("J31: Recova's page frame, inside the settings column", () => {
  it("adds no column of its own: the settings layout already gives Recova's 800px and padding", () => {
    const html = render(AS_OWNER);
    expect(html).not.toContain("max-w-3xl");
    expect(html).not.toContain("mx-auto");
    expect(html).not.toMatch(/class="[^"]*\bpy-8\b/);
  });

  it("the phone-only back link to Settings comes first", () => {
    const html = render(AS_OWNER);
    const link = html.match(/<a[^>]*href="\/settings"[^>]*>[\s\S]*?<\/a>/);
    expect(link, "a link to /settings").not.toBeNull();
    expect(link![0]).toMatch(/class="[^"]*\bmd:hidden\b/);
    expect(text(link![0])).toBe("Settings");
    expect(html.indexOf('href="/settings"')).toBeLessThan(html.indexOf("<h1"));
  });

  it("Recova's heading and the line under it, on the five sizes", () => {
    // Recova's PageHeader: h1 text-title font-medium, the line text-[0.8125rem]
    // (text-label). Capsomer's page head computes 22px, off the five.
    const html = render(AS_OWNER);
    expect(html).toMatch(/<h1 class="[^"]*\btext-title\b[^"]*\bfont-medium\b[^"]*">Team<\/h1>/);
    expect(html).toMatch(/<p class="[^"]*\btext-label\b[^"]*">Members and pending invites for this account.<\/p>/);
    expect(html).not.toContain("cap-page-head");
  });

  it("one Capsomer card holding the list and then the form, with no headings inside", () => {
    const html = render(AS_OWNER);
    expect(html.match(/class="cap-panel"/g)).toHaveLength(1);
    expect(html).not.toMatch(/<h2/);
    expect(html).not.toContain("Invite a teammate");
    const panel = html.slice(html.indexOf('class="cap-panel"'));
    inOrder(panel, ["Dana Owner", "Sam Member", "new@example.com", "Invite a team member"]);
  });
});

describe("J31: the member rows", () => {
  it("each role is a Capsomer pill in words, the owner's in the teal fill and set apart", () => {
    const html = render(AS_OWNER);
    expect(html).toContain('<span class="cap-pill" data-variant="default">Owner</span>');
    expect(html.match(/<span class="cap-pill" data-variant="secondary">Member<\/span>/g)).toHaveLength(2);
    // Never the raw database value.
    expect(html).not.toMatch(/>owner</);
    expect(html).not.toMatch(/>member</);
  });

  it("a Pending pill only on the pending row", () => {
    const html = render(AS_OWNER);
    expect(html.match(/<span class="cap-pill" data-variant="secondary">Pending<\/span>/g)).toHaveLength(1);
    const pendingRow = html.slice(html.indexOf("new@example.com"));
    expect(pendingRow).toContain("Pending");
  });

  it("an empty name falls through to the email, as Recova's || does", () => {
    const html = render({ ...AS_OWNER, members: [OWNER_ROW, { ...MEMBER_ROW, userName: "" }] } as LoaderData);
    expect(text(html)).toContain("sam@example.com");
  });

  it("Remove member is a quiet Capsomer button link per removable row, named for its person", () => {
    const html = render(AS_OWNER);
    const links = [...html.matchAll(/<a[^>]*href="\?confirm=([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
    expect(links.map((m) => m[1])).toEqual(["m_sam", "m_pend"]);
    for (const m of links) {
      expect(m[0]).toMatch(/class="cap-btn"/);
      expect(m[0]).toContain('data-variant="quiet"');
      // sm is 13px (text-label); xs computes 12px, off the five sizes.
      expect(m[0]).toContain('data-size="sm"');
      expect(text(m[2])).toBe("Remove member");
    }
    expect(links[0][2]).toContain('<span class="sr-only"> Sam Member</span>');
  });

  it("the confirm keeps Recova's words on Capsomer's danger and quiet buttons", () => {
    const html = render(AS_OWNER, undefined, "/settings/team?confirm=m_sam");
    const t = text(html);
    inOrder(t, ["Sam Member", "Remove Sam Member?", "Yes, remove member", "Cancel", "Member"]);
    expect(html).toMatch(/<button[^>]*class="cap-btn"[^>]*data-variant="danger"[^>]*data-size="sm"[^>]*>Yes, remove member<\/button>/);
    expect(html).toMatch(/<a[^>]*class="cap-btn"[^>]*data-variant="quiet"[^>]*href="\?"[^>]*>Cancel<\/a>|<a[^>]*href="\?"[^>]*class="cap-btn"[^>]*data-variant="quiet"[^>]*>Cancel<\/a>/);
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
  it("Recova's label, placeholder and button, input and button on one row, on Capsomer's field", () => {
    const html = render(AS_OWNER);
    expect(html).toMatch(/<label class="cap-field-label" for="invite_email">Invite a team member<\/label>/);
    const input = html.match(/<input[^>]*id="invite_email"[^>]*>/);
    expect(input).not.toBeNull();
    for (const attr of ['class="cap-input', 'type="email"', 'name="email"', 'placeholder="colleague@company.com"', "required"]) {
      expect(input![0]).toContain(attr);
    }
    const row = html.slice(html.indexOf('id="invite_email"'));
    // The input, then (past its own sizing wrapper) the button, nothing between.
    expect(row).toMatch(/^[^<]*>(\s*<\/div>)?\s*<button[^>]*class="cap-btn"[^>]*data-variant="primary"[^>]*>Send invite<\/button>/);
    expect(html).not.toContain("Invite email");
  });

  it("the result line sits under the input row, success and error alike", () => {
    const ok = render(AS_OWNER, {
      error: null,
      invited: "new@example.com",
      inviteUrl: "https://foxhoundapp.test/invite/tok",
    } as ActionData);
    inOrder(text(ok), ["Send invite", "Invited new@example.com. Share this link: https://foxhoundapp.test/invite/tok"]);

    const bad = render(AS_OWNER, { error: "Enter an email address to invite.", invited: null, inviteUrl: null } as ActionData);
    inOrder(text(bad), ["Send invite", "Enter an email address to invite."]);
    expect(bad).toMatch(/<div class="cap-alert" data-tone="crit" role="alert">/);
    expect(ok).toMatch(/<div class="cap-alert" data-tone="ok" role="alert">/);
  });
});

describe("J31: sizes and colour", () => {
  it("every Tailwind text size on the page is one of the five", () => {
    const five = new Set(["text-display", "text-title", "text-body", "text-label", "text-micro"]);
    for (const state of [render(AS_OWNER), render(AS_OWNER, undefined, "/settings/team?confirm=m_sam"), render(AS_MEMBER)]) {
      const sizes = sizeClasses(state);
      expect(sizes.length, "the page carries text sizes to check").toBeGreaterThan(0);
      for (const s of sizes) expect(five.has(s), `${s} is one of the five`).toBe(true);
    }
  });

  it("no amber anywhere, teal only", () => {
    for (const state of [render(AS_OWNER), render(AS_OWNER, undefined, "/settings/team?confirm=m_sam")]) {
      expect(state).not.toMatch(/amber/i);
    }
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
  });

  it("owner first, then the rest in the order they joined", async () => {
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
    expect(loaded.members.map((m) => m.id)).toEqual(["m_owner", "m_a", "m_b"]);
  });
});
