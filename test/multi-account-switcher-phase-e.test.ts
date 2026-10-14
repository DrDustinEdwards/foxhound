import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cloudflareContext } from "~/lib/cloudflare-context";

import { createInMemoryDb } from "./helpers/inmemory-db";

// Phase (e) of the multi-account build (ruling 326, planned at 328): the visible
// account switcher, in the marketing header (M1) and the app shell (S1), plus
// the first half of phase (d), the add-account route that marks its OAuth state.
//
// THE 323 BOUND APPLIES AND IS NOT WORKED AROUND HERE. Every marketing walk in
// this campaign ran ANONYMOUS, and the viewport harness has no session cookie,
// so the AUTHENTICATED chrome this session builds CANNOT be walked visually in
// this environment. These assertions prove the control is built to legacy's
// source: the data shape, the render structure, the render rule, the href, and
// the state marker. They do NOT prove visual parity, and no test here should be
// read as claiming it. Dustin owes the signed-in legacy screenshots.
//
// NO WIDE-DASH ASSERTION LIVES HERE, deliberately. Writing one means putting the
// forbidden characters in a source file, and the PreToolUse hook that enforces
// the rule blocked two attempts to add it during this very session, which is
// stronger evidence than a test would have been. The hook is the enforcement
// site (CLAUDE.md); a per-file copy of it is not.

const harness = vi.hoisted(() => ({ db: null as unknown, session: null as unknown }));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

vi.mock("~/lib/auth/session", () => ({ getSession: async () => harness.session }));

const { listSwitcherAccounts } = await import("~/lib/nav/accounts.server");
const { listMemberships } = await import("~/lib/auth/account");
const { ADD_ACCOUNT_PATH } = await import("~/lib/nav/paths");
const { ADD_ACCOUNT_ACTION, buildConnectState, parseConnectState } = await import(
  "~/lib/stripe/connect-state"
);
const { accountLabel, accountInitial, businessSwitcher, switchAccountHref, switchTargetFromHref } = await import(
  "~/components/nav/account-switcher"
);
const { loader: addAccountLoader } = await import("~/routes/auth/connect-additional");

const USER = "user_1";

let sqlite: Database.Database;
let db: ReturnType<typeof createInMemoryDb>["db"];

beforeEach(() => {
  ({ sqlite, db } = createInMemoryDb());
  harness.db = db;
  harness.session = null;
  sqlite
    .prepare("INSERT INTO user (id, name, email, email_verified, updated_at) VALUES (?, ?, ?, 0, 0)")
    .run(USER, "Dustin", "owner@acme.test");
});

function seedAccount(id: string, name: string | null, createdAt = 1_000): void {
  sqlite
    .prepare("INSERT INTO accounts (id, name, created_at) VALUES (?, ?, ?)")
    .run(id, name, createdAt);
}

function seedMembership(id: string, accountId: string, createdAt = 1_000): void {
  sqlite
    .prepare(
      "INSERT INTO account_members (id, account_id, user_id, role, status, created_at) VALUES (?, ?, ?, 'owner', 'active', ?)",
    )
    .run(id, accountId, USER, createdAt);
}

function seedConnection(opts: {
  id: string;
  accountId: string;
  stripeUserId: string;
  isPrimary?: boolean;
}): void {
  sqlite
    .prepare(
      "INSERT INTO stripe_connections (id, account_id, stripe_user_id, is_primary, created_at) VALUES (?, ?, ?, ?, 1000)",
    )
    .run(opts.id, opts.accountId, opts.stripeUserId, opts.isPrimary === false ? 0 : 1);
}

function seedSession(id: string, activeAccountId: string | null = null): void {
  sqlite
    .prepare(
      "INSERT INTO session (id, expires_at, token, updated_at, user_id, active_account_id) VALUES (?, ?, ?, 0, ?, ?)",
    )
    .run(id, 9_999_999_999_999, `tok_${id}`, USER, activeAccountId);
  harness.session = {
    user: { id: USER, name: "Dustin", email: "owner@acme.test" },
    session: { id, activeAccountId },
  };
}

describe("the switcher's data, assembled legacy's way", () => {
  it("two memberships yield two rows, each with its own primary stripe_user_id", async () => {
    seedAccount("acct_a", "Acme", 1_000);
    seedAccount("acct_b", "Globex", 2_000);
    seedMembership("m1", "acct_a", 1_000);
    seedMembership("m2", "acct_b", 2_000);
    seedConnection({ id: "c1", accountId: "acct_a", stripeUserId: "acct_stripe_A" });
    seedConnection({ id: "c2", accountId: "acct_b", stripeUserId: "acct_stripe_B" });

    const rows = await listSwitcherAccounts(db, await listMemberships(db, USER));

    expect(rows).toEqual([
      { id: "acct_a", name: "Acme", stripeUserId: "acct_stripe_A" },
      { id: "acct_b", name: "Globex", stripeUserId: "acct_stripe_B" },
    ]);
  });

  it("an account with NO connection yields null, not a string and not a placeholder", async () => {
    seedAccount("acct_a", "Acme");
    seedAccount("acct_b", "Not connected yet", 2_000);
    seedMembership("m1", "acct_a", 1_000);
    seedMembership("m2", "acct_b", 2_000);
    seedConnection({ id: "c1", accountId: "acct_a", stripeUserId: "acct_stripe_A" });

    const rows = await listSwitcherAccounts(db, await listMemberships(db, USER));

    const b = rows.find((r) => r.id === "acct_b");
    expect(b?.stripeUserId).toBeNull();
    // Not undefined, not "", not the account id wearing a disguise: legacy's
    // `?? null` (SiteNav.tsx:88) makes the absence explicit.
    expect(b).toEqual({ id: "acct_b", name: "Not connected yet", stripeUserId: null });
  });

  it("ignores non-primary connections, which is legacy's is_primary filter", async () => {
    seedAccount("acct_a", "Acme");
    seedMembership("m1", "acct_a");
    seedConnection({
      id: "c_secondary",
      accountId: "acct_a",
      stripeUserId: "acct_stripe_SECOND",
      isPrimary: false,
    });

    const rows = await listSwitcherAccounts(db, await listMemberships(db, USER));
    expect(rows[0].stripeUserId).toBeNull();
  });

  it("cannot widen past the memberships handed to it", async () => {
    seedAccount("acct_a", "Acme");
    seedAccount("acct_theirs", "Someone else");
    seedMembership("m1", "acct_a");
    seedConnection({ id: "c1", accountId: "acct_a", stripeUserId: "acct_stripe_A" });
    seedConnection({ id: "c9", accountId: "acct_theirs", stripeUserId: "acct_stripe_THEIRS" });

    const rows = await listSwitcherAccounts(db, await listMemberships(db, USER));
    expect(rows.map((r) => r.id)).toEqual(["acct_a"]);
  });

  it("an empty membership list is a constant, not a query", async () => {
    expect(await listSwitcherAccounts(db, [])).toEqual([]);
  });
});

describe("legacy's label fallback chain", () => {
  it("name, else the Stripe account id, else eight characters of the account id", () => {
    expect(accountLabel({ id: "abcdefghijkl", name: "Acme", stripeUserId: "acct_x" })).toBe("Acme");
    expect(accountLabel({ id: "abcdefghijkl", name: null, stripeUserId: "acct_x" })).toBe("acct_x");
    expect(accountLabel({ id: "abcdefghijkl", name: null, stripeUserId: null })).toBe("abcdefgh");
    // Empty string is falsy in legacy's `||` chain too, so a blank name falls
    // through rather than rendering an empty row.
    expect(accountLabel({ id: "abcdefghijkl", name: "", stripeUserId: "acct_x" })).toBe("acct_x");
  });

  it("the initial is the label's first character, uppercased", () => {
    expect(accountInitial({ id: "abcdefghijkl", name: "acme", stripeUserId: null })).toBe("A");
    expect(accountInitial({ id: "abcdefghijkl", name: null, stripeUserId: null })).toBe("A");
  });
});

/** Source with comments removed.
 *
 *  Every geometry assertion below runs against THIS, not the raw file, and the
 *  reason is ruling 316's vacuous-assertion catch: this component's comments
 *  quote legacy's classes and name the very tokens the assertions forbid, so a
 *  `toContain` over the raw text would pass on prose while the JSX said
 *  something else entirely. The first run of this file proved it: the no-ring
 *  assertion went red against a comment EXPLAINING that the ring was removed. */
function code(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

describe("the switcher, in Capsomer's site header (Dustin's answer 3, 2026-10-13)", () => {
  // Phase (e) built the switcher to legacy's AccountSwitcher.tsx (blob
  // 70567b69) as a round avatar on the right. Capsomer 0.9.0's site header
  // moves it to the LEFT as a square tile with the business's initial, before
  // the product switcher, and its panel is Capsomer's. That is an approved
  // difference (parity/APPROVED-DIFFERENCES.md), so legacy's geometry
  // assertions went with the old dropdown. What legacy fixed and the move
  // keeps is pinned here: the rows, the switch transport and the add row.
  const SOURCE = code("../app/components/nav/account-switcher.tsx");
  const accounts = [
    { id: "acct_a", name: "Acme Supply Co.", stripeUserId: null },
    { id: "acct_b", name: null, stripeUserId: "acct_1Stripe" },
  ];

  it("the comment stripper actually stripped something", () => {
    // Calibration, so "not present" cannot quietly mean "nothing was read".
    const raw = readFileSync(
      fileURLToPath(new URL("../app/components/nav/account-switcher.tsx", import.meta.url)),
      "utf8",
    );
    expect(SOURCE.length).toBeGreaterThan(500);
    expect(SOURCE.length).toBeLessThan(raw.length);
    expect(raw).toContain("AccountSwitcher.tsx:112");
    expect(SOURCE).not.toContain("AccountSwitcher.tsx:112");
  });

  it("is a square tile with the ACTIVE account's initial and label", () => {
    const sw = businessSwitcher(accounts, "acct_b");
    expect(sw?.tile).toBe("A");
    expect(sw?.label).toBe("acct_1Stripe");
    expect(sw?.name).toBe("Switch account: acct_1Stripe");
    // Falls back to the first account when the active id is unknown.
    expect(businessSwitcher(accounts, "gone")?.label).toBe("Acme Supply Co.");
  });

  it("lists every account, the active one current, then + Add account", () => {
    const sw = businessSwitcher(accounts, "acct_a")!;
    expect(sw.groups).toHaveLength(1);
    const links = sw.groups[0]!.links;
    expect(links.map((l) => [l.label, Boolean(l.current)])).toEqual([
      ["Acme Supply Co.", true],
      ["acct_1Stripe", false],
      ["+ Add account", false],
    ]);
    expect(links.at(-1)).toEqual({ id: "add-account", label: "+ Add account", href: ADD_ACCOUNT_PATH });
  });

  it("is absent with no account at all", () => {
    expect(businessSwitcher([], null)).toBeNull();
  });

  it("an account row switches through the POST, then hard-navigates (legacy's re-read)", () => {
    expect(switchTargetFromHref(switchAccountHref("acct_b"))).toBe("acct_b");
    expect(switchTargetFromHref("/settings")).toBeNull();
    expect(SOURCE).toContain("window.location.assign");
    expect(SOURCE).toContain("window.location.pathname + window.location.search");
    // The switch itself goes to phase (b)'s action.
    expect(SOURCE).toContain('"/api/account/switch"');
    // The header draws that row as a button, and a current row switches nothing.
    const RENDER = code("../app/components/site-header.tsx");
    expect(RENDER).toContain("switchTargetFromHref(href)");
    expect(RENDER).toContain("if (!isCurrent) void switchAccount(switchTo)");
  });

  it("the + Add account href is the marked route and is NEVER /connect", () => {
    // LEGACY DEFECT 1, asserted against. AccountSwitcher.tsx:112 points this row
    // at "/connect", which falls through to the callback's upsert branch and
    // attaches the new Stripe account to the user's FIRST account instead of
    // creating a second one. Ruling 326 ported the intent, never the transport.
    expect(SOURCE).toContain("href: ADD_ACCOUNT_PATH");
    expect(SOURCE).not.toContain('href: "/connect"');
    expect(ADD_ACCOUNT_PATH).not.toBe("/connect");
    expect(ADD_ACCOUNT_PATH).toBe("/connect/additional");
  });
});

describe("the render rule, read from legacy's nav", () => {
  const HEADER = code("../app/components/header.tsx");
  const SHELL = code("../app/layouts/app-shell.tsx");

  it("SHOWN at one account, which is what legacy's own condition resolves to", () => {
    // components/SiteNavClient.tsx:
    //   accountAvatarVisible = accounts.length > 0
    //     && (multiSeat || (isAuthenticated && hasAccount))
    // With one account `multiSeat` is false and the second clause is true, so
    // the switcher renders, listing that one account plus + Add account. The
    // gate is therefore "has any account", never "has two".
    expect(HEADER).toContain("isAuthenticated && accounts.length > 0");
    expect(HEADER).not.toContain("accounts.length > 1");
    expect(SHELL).not.toContain("accounts.length > 1");
  });

  it("HIDDEN when the visitor has no account at all", () => {
    expect(HEADER).toContain("accounts.length > 0");
  });

  it("both M1 and S1 build the same switcher", () => {
    // One header serves desktop and phone (Capsomer draws the switcher in the
    // row on a desktop and in the sheet on a phone), so each builds it once.
    expect(HEADER.match(/businessSwitcher\(/g) ?? []).toHaveLength(1);
    expect(SHELL.match(/businessSwitcher\(/g) ?? []).toHaveLength(1);
  });

  it("the demo shell renders no switcher, so the demo_ firewall is untouched", () => {
    expect(SHELL).toContain("!isDemo && accounts.length > 0");
  });

  it("M1's ANONYMOUS render is unchanged: no switcher, no membership query", () => {
    const MARKETING = code("../app/layouts/marketing.tsx");
    // The anonymous branch returns before `getDb` is ever called, so ruling 59's
    // zero-DB rule for that surface still holds, and it hands the header an
    // empty list so the switcher's own gate keeps it off the page.
    const anonymousBranch = MARKETING.slice(
      MARKETING.indexOf("if (!session)"),
      MARKETING.indexOf("const db = getDb(env)"),
    );
    expect(anonymousBranch).toContain("accounts: []");
    expect(anonymousBranch).not.toContain("getDb");
    expect(anonymousBranch).not.toContain("listMemberships");
  });
});

describe("the add-account route marks its OAuth state", () => {
  const fakeContext = {
    get(key: unknown) {
      if (key === cloudflareContext) {
        return {
          env: { STRIPE_CLIENT_ID: "ca_test", BETTER_AUTH_URL: "https://foxhoundapp.test" } as never,
          ctx: {} as ExecutionContext,
          nonce: "n",
        };
      }
      throw new Error("unexpected context key");
    },
  } as unknown as Parameters<typeof addAccountLoader>[0]["context"];

  async function run(): Promise<Response> {
    try {
      return (await addAccountLoader({
        context: fakeContext,
        request: new Request("https://foxhoundapp.test/connect/additional"),
        params: {},
      } as never)) as unknown as Response;
    } catch (thrown) {
      // React Router's redirect() is thrown from a loader.
      if (thrown instanceof Response) return thrown;
      throw thrown;
    }
  }

  it("encodes action add_account into both the state param and the cookie", async () => {
    seedAccount("acct_a", "Acme");
    seedMembership("m1", "acct_a");
    seedSession("sess_1");

    const res = await run();

    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    const state = location.searchParams.get("state")!;
    // THE ASSERTION THIS ROUTE EXISTS FOR. Legacy's connect-additional encodes
    // `action: 'add_account'` "so the callback creates a new account"
    // (blob 60f93b27). Without the marker the callback's default branch upserts
    // onto the existing account, which is the defect, not the feature.
    expect(parseConnectState(state)?.action).toBe(ADD_ACCOUNT_ACTION);
    // Legacy puts the SAME payload in the cookie, and Foxhound's callback
    // compares the two by string equality, so they must match exactly.
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toContain(state);
    expect(cookie).toContain("HttpOnly");
  });

  it("sends an accountless caller to /connect, legacy's own precondition", async () => {
    seedSession("sess_1");
    const res = await run();
    expect(res.headers.get("location")).toBe("/connect");
  });

  it("sends an anonymous caller to /login", async () => {
    harness.session = null;
    const res = await run();
    expect(res.headers.get("location")).toBe("/login");
  });

  it("NO LONGER fails closed when active and earliest differ (phase (d) retired that guard)", async () => {
    // Phase (e) refused this case, because connect-callback.ts attached to the
    // EARLIEST membership and would have put a live payment processor on the
    // wrong ledger. Phase (d) made add_account mint its own account instead, so
    // the question the guard asked has no answer to get wrong, and refusing
    // would now block the feature rather than protect it. Ruling 329 ratified
    // the guard for its window and assigned the window's closure.
    seedAccount("acct_a", "Acme", 1_000);
    seedAccount("acct_b", "Globex", 2_000);
    seedMembership("m1", "acct_a", 1_000);
    seedMembership("m2", "acct_b", 2_000);
    seedSession("sess_1", "acct_b"); // switched away from the earliest

    const res = await run();

    expect(res.headers.get("location")).toContain("connect.stripe.com");
    expect(res.headers.get("location")).not.toContain("add_account_unavailable");
  });

  it("proceeds when the active account IS the earliest, the single-account case", async () => {
    seedAccount("acct_a", "Acme");
    seedMembership("m1", "acct_a");
    seedSession("sess_1", "acct_a");

    const res = await run();
    expect(res.headers.get("location")).toContain("connect.stripe.com");
  });
});

describe("the state payload format", () => {
  it("round-trips the marker", () => {
    const state = buildConnectState(ADD_ACCOUNT_ACTION, "nonce-value");
    expect(parseConnectState(state)).toEqual({ nonce: "nonce-value", action: ADD_ACCOUNT_ACTION });
  });

  it("REFUSES a bare uuid, which phase (d) made an invalid state", () => {
    // Phase (e) read an unparseable state as a bare csrf with no action, which
    // is legacy's own fallback and legacy's own hole: an action-less state runs
    // the default branch. Ruling 329 phase (d) mints both flows, so it can
    // require the shape.
    expect(parseConnectState("6f1c9b1e-0000-4000-8000-000000000000")).toBeNull();
  });

  it("refuses an action outside the two known ones", () => {
    expect(parseConnectState(JSON.stringify({ nonce: "x", action: "something_else" }))).toBeNull();
  });

  it("the route is mounted at the path the switcher links to", async () => {
    const routes = (await import("~/routes")).default;
    const flat = JSON.stringify(routes);
    expect(flat).toContain("./routes/auth/connect-additional.ts");
    expect(flat).toContain(ADD_ACCOUNT_PATH.slice(1));
  });
});
