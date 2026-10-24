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
const { ADD_ACCOUNT_ACTION, parseConnectState } = await import(
  "~/lib/stripe/connect-state"
);
const { accountLabel, accountInitial } = await import(
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
});
