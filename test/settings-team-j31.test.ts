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
// the result line under them. The parts are Capsomer's (Q10, Q12), amber,
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

  it("the list sits straight in the panel body, with no bare wrapper between", () => {
    const html = render(AS_OWNER);
    expect(html).toMatch(/<div class="cap-panel-body"><ul /);
  });
});

describe("J31: the member rows", () => {
  it("each role is a Capsomer pill in words, the owner's in the amber fill and set apart", () => {
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
    const html = render({ ...AS_OWNER, members: [OWNER_ROW, { ...MEMBER_ROW, userName: "" }] });
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
    const ok = render(AS_OWNER, INVITE_OK);
    inOrder(text(ok), ["Send invite", "Invited new@example.com. Share this link: https://foxhoundapp.test/invite/tok"]);

    const bad = render(AS_OWNER, INVITE_BAD);
    inOrder(text(bad), ["Send invite", "Enter an email address to invite."]);
  });

  it("a sent invite is a polite status notice, not an alert", () => {
    // Capsomer's Banner: role=status for every tone but crit. Alert is for failures.
    const ok = render(AS_OWNER, INVITE_OK);
    expect(ok).toMatch(/<div class="cap-banner" data-tone="ok" role="status">/);
    expect(ok).not.toContain('role="alert"');
  });

  it("an invite error is the field's own error, wired to the input", () => {
    const bad = render(AS_OWNER, INVITE_BAD);
    const input = bad.match(/<input[^>]*id="invite_email"[^>]*>/)![0];
    expect(input).toContain('aria-invalid="true"');
    expect(input).toContain('aria-describedby="invite_email-error"');
    expect(bad).toMatch(/<p class="cap-field-error" id="invite_email-error"[^>]*>Enter an email address to invite.<\/p>/);
    expect(bad).toMatch(/<div class="cap-field" data-invalid="true">/);

    const clean = render(AS_OWNER).match(/<input[^>]*id="invite_email"[^>]*>/)![0];
    expect(clean).not.toContain("aria-invalid");
  });

  it("the invite form names its own action, so pending and results can tell the forms apart", () => {
    const html = render(AS_OWNER);
    const form = html.slice(html.lastIndexOf("<form"));
    expect(form).toContain('<input type="hidden" name="_action" value="invite"/>');
  });
});

describe("J31: sizes and colour", () => {
  // WHAT THIS READS: only the Tailwind text-size classes the page itself
  // writes. It does not read the sizes Capsomer's parts compute. Measured in
  // a browser at a87fda7 (Foxhound's five are 28, 20, 16, 13 and 11px), these
  // Capsomer parts on this page compute off the five or off Recova's size:
  // the pills 12px (--fs-detail), the field's error line 12px (--fs-detail),
  // and the field label 16px weight 600 (one of the five, but Recova's label
  // is 13px regular). The sm buttons and the primary button compute 13px. The
  // fix for those is Capsomer's per-site layer, not this page.
  it("every Tailwind text-size class the page writes is one of the five (Capsomer parts not read)", () => {
    const five = new Set(["text-display", "text-title", "text-body", "text-label", "text-micro"]);
    for (const state of [render(AS_OWNER), render(AS_OWNER, undefined, "/settings/team?confirm=m_sam"), render(AS_MEMBER)]) {
      const sizes = sizeClasses(state);
      expect(sizes.length, "the page carries text sizes to check").toBeGreaterThan(0);
      for (const s of sizes) expect(five.has(s), `${s} is one of the five`).toBe(true);
    }
  });

});

describe("J31: the remove result, where Recova shows it", () => {
  // Recova's TeamSection has ONE error line, under the invite row, and a
  // refused remove lands there (setError). Showing it at the row would be a
  // visible difference with no approval (RULES.md 1.3); that placement is a
  // question for Dustin in the J31 notes.
  for (const memberId of ["m_sam", "m_gone"]) {
    it(`a refused remove (row ${memberId}) shows under the invite row, as an alert, never in the list`, () => {
      const html = render(AS_OWNER, {
        action: "remove",
        error: "The account owner cannot be removed.",
        invited: null,
        inviteUrl: null,
        memberId,
      });
      inOrder(text(html), ["Dana Owner", "Sam Member", "new@example.com", "Send invite", "The account owner cannot be removed."]);
      const list = html.slice(html.indexOf("<ul"), html.indexOf("</ul>"));
      expect(list).not.toContain("The account owner cannot be removed.");
      const form = html.slice(html.lastIndexOf("<form"));
      expect(form).toMatch(/<div class="cap-alert" data-tone="crit" role="alert">[\s\S]*The account owner cannot be removed\./);
      // It is not the field's error: the address is not what was wrong.
      expect(html.match(/<input[^>]*id="invite_email"[^>]*>/)![0]).not.toContain("aria-invalid");
    });
  }

  it("a removal that worked is announced politely, with nothing new drawn", () => {
    // Recova draws nothing when a member is removed; the row just goes. A
    // screen reader user gets the same news through a status line.
    const html = render(AS_OWNER, { action: "remove", error: null, invited: null, inviteUrl: null, memberId: "m_sam" });
    expect(html).toContain('<p role="status" class="sr-only">Member removed.</p>');
  });

  it("an invite result never appears at a row", () => {
    const html = render(AS_OWNER, INVITE_BAD);
    const list = html.slice(html.indexOf("<ul"), html.indexOf("</ul>"));
    expect(list).not.toContain("Enter an email address");
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
