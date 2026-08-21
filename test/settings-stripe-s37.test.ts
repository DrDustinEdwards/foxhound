import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";

import { createInMemoryDb } from "./helpers/inmemory-db";

// S37: disconnect per connection, and cancel account. Rulings 40 and 333.
//
// THIS IS THE MONEY-ADJACENT SETTINGS SURFACE. A disconnect decides whether a
// merchant's Stripe account keeps feeding the recovery engine, and a cancel
// stops processing for an entire account while leaving owed fees owed. So every
// refusing branch is asserted to have written NOTHING, and the billing rows are
// asserted untouched on the path that stops the business relationship.
//
// 333 ruled these writes go through cancelMerchant's PLAIN batch path and NOT
// executeMoneyWrite: an account-state write is not outcome recording, attributed
// billing, or a webhook claim, and a second writer on
// stripe_connections.disconnected_at with a different atomicity guarantee is
// 262 decision five's shape one table over.

const harness = vi.hoisted(() => ({
  db: null as unknown,
  session: null as unknown,
  deauthorizeOk: true,
  deauthorizeCalls: [] as string[],
}));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

vi.mock("~/lib/auth/session", () => ({ getSession: async () => harness.session }));

vi.mock("~/lib/stripe/connect", () => ({
  deauthorizeConnectedAccount: async (_env: unknown, stripeUserId: string) => {
    harness.deauthorizeCalls.push(stripeUserId);
    return harness.deauthorizeOk ? { ok: true } : { ok: false, error: "grant already revoked" };
  },
}));

const { action, loader } = await import("~/routes/app/settings/index");
const schema = await import("~/db/schema");
const { listSwitcherAccounts } = await import("~/lib/nav/accounts.server");
const { listMemberships } = await import("~/lib/auth/account");
const { accountProcessingEligibleCondition } = await import("~/lib/cron/recovery-tick");

const USER = "user_1";
const ACTIVE = "acct_active";
const EARLIEST = "acct_earliest";

let sqlite: Database.Database;
let db: ReturnType<typeof createInMemoryDb>["db"];

beforeEach(() => {
  ({ sqlite, db } = createInMemoryDb());
  harness.db = db;
  harness.deauthorizeOk = true;
  harness.deauthorizeCalls = [];

  sqlite
    .prepare("INSERT INTO user (id, name, email, email_verified, updated_at) VALUES (?, ?, ?, 0, 0)")
    .run(USER, "Owner", "owner@acme.test");
  // The caller holds TWO accounts and is switched to the LATER one, so every
  // active-account assertion below can fail in the direction that matters.
  seedAccount(EARLIEST, "Earliest Co", 1_000);
  seedAccount(ACTIVE, "Active Co", 2_000);
  seedMembership("m1", EARLIEST, 1_000);
  seedMembership("m2", ACTIVE, 2_000);
  seedSession("sess_1", ACTIVE);
});

function seedAccount(id: string, name: string, createdAt: number): void {
  sqlite
    .prepare("INSERT INTO accounts (id, name, created_at, billing_exempt) VALUES (?, ?, ?, 0)")
    .run(id, name, createdAt);
}

function seedMembership(id: string, accountId: string, createdAt: number): void {
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
  connectedAt?: number;
  disconnectedAt?: number | null;
}): void {
  sqlite
    .prepare(
      "INSERT INTO stripe_connections (id, account_id, stripe_user_id, is_primary, connected_at, disconnected_at, created_at) VALUES (?, ?, ?, ?, ?, ?, 1000)",
    )
    .run(
      opts.id,
      opts.accountId,
      opts.stripeUserId,
      opts.isPrimary ? 1 : 0,
      opts.connectedAt ?? 1_000,
      opts.disconnectedAt ?? null,
    );
}

function seedSession(id: string, activeAccountId: string): void {
  sqlite
    .prepare(
      "INSERT INTO session (id, expires_at, token, updated_at, user_id, active_account_id) VALUES (?, ?, ?, 0, ?, ?)",
    )
    .run(id, 9_999_999_999_999, "tok_" + id, USER, activeAccountId);
  harness.session = {
    user: { id: USER, name: "Owner", email: "owner@acme.test" },
    session: { id, activeAccountId },
  };
}

function connectionRow(id: string): { disconnectedAt: number | null; isPrimary: number } {
  return sqlite
    .prepare("SELECT disconnected_at AS disconnectedAt, is_primary AS isPrimary FROM stripe_connections WHERE id = ?")
    .get(id) as { disconnectedAt: number | null; isPrimary: number };
}

function markerOf(sessionId: string): string | null {
  const row = sqlite
    .prepare("SELECT active_account_id AS m FROM session WHERE id = ?")
    .get(sessionId) as { m: string | null } | undefined;
  return row?.m ?? null;
}

/** Context carrying the ACTIVE account, which is what guards.ts resolves from
 *  the session marker. Every S37 assertion turns on this being the active
 *  account and never the earliest membership. */
const ctx = {
  get(key: unknown) {
    if (key === cloudflareContext) return { env: {} as Env, ctx: {} as ExecutionContext, nonce: "n" };
    if (key === authContext) {
      return {
        userId: USER,
        userName: "Owner",
        email: "owner@acme.test",
        membership: { memberId: "m2", accountId: ACTIVE, accountName: "Active Co", role: "owner" },
        memberships: [
          { memberId: "m1", accountId: EARLIEST, accountName: "Earliest Co", role: "owner" },
          { memberId: "m2", accountId: ACTIVE, accountName: "Active Co", role: "owner" },
        ],
        activeAccountId: ACTIVE,
        isAdmin: false,
        isDemo: false,
        demoSignedIn: false,
      };
    }
    throw new Error("unexpected context key");
  },
} as unknown as Parameters<typeof action>[0]["context"];

async function post(fields: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const res = (await action({
    context: ctx,
    request: new Request("https://foxhoundapp.test/settings", { method: "POST", body: form }),
    params: {},
  } as never)) as unknown as { data: Record<string, unknown>; init?: { status?: number } };
  return { status: res.init?.status ?? 200, body: res.data };
}

describe("PLANT 1: the client method and the route method agree", () => {
  const SOURCE = readFileSync(
    fileURLToPath(new URL("../app/routes/app/settings/index.tsx", import.meta.url)),
    "utf8",
  );

  it("both S37 forms POST, and the route handles them in its action", () => {
    // LEGACY'S DEFECT, asserted against. Its client sent
    // fetch(..., { method: 'POST' }) at a route exporting only DELETE, so the
    // button could never succeed (325). Here both intents are form posts to this
    // route's own action, so the methods agree by construction.
    const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const forms = code.match(/<DemoGuardedForm method="post"/g) ?? [];
    expect(forms.length).toBeGreaterThanOrEqual(2);
    expect(code).not.toMatch(/method="(delete|DELETE|get|GET)"/);
    expect(code).toContain('value="disconnect-stripe"');
    expect(code).toContain('value="cancel-account"');
    expect(code).toContain("export async function action");
  });

  it("the disconnect form carries a REAL connection id, not a decorative one", () => {
    // Legacy takes an id in its handler and then sends no body at all, so its
    // route resolves is_primary itself and the second row disconnects the first.
    expect(SOURCE).toContain('name="connectionId" value={conn.id}');
  });
});

describe("PLANT 2: disconnect refuses what the active account does not own", () => {
  it("403 and NO write for a connection on another user's account", async () => {
    seedAccount("acct_theirs", "Someone else", 3_000);
    seedConnection({ id: "c_theirs", accountId: "acct_theirs", stripeUserId: "acct_x" });

    const res = await post({ _action: "disconnect-stripe", connectionId: "c_theirs" });

    expect(res.status).toBe(403);
    expect(connectionRow("c_theirs").disconnectedAt).toBeNull();
    expect(harness.deauthorizeCalls).toEqual([]);
  });

  it("403 and NO write for a connection under the EARLIEST account the caller holds", async () => {
    // The sharp case. The caller owns this account, so a shim that resolved the
    // earliest membership would happily disconnect it.
    seedConnection({ id: "c_earliest", accountId: EARLIEST, stripeUserId: "acct_earliest_stripe" });

    const res = await post({ _action: "disconnect-stripe", connectionId: "c_earliest" });

    expect(res.status).toBe(403);
    expect(connectionRow("c_earliest").disconnectedAt).toBeNull();
    expect(harness.deauthorizeCalls).toEqual([]);
  });

  it("400 and NO write when no connection id is sent, which is legacy's actual request", async () => {
    seedConnection({ id: "c_active", accountId: ACTIVE, stripeUserId: "acct_a", isPrimary: true });

    const res = await post({ _action: "disconnect-stripe" });

    expect(res.status).toBe(400);
    expect(connectionRow("c_active").disconnectedAt).toBeNull();
  });

  it("403 for a connection that is already disconnected", async () => {
    seedConnection({ id: "c_gone", accountId: ACTIVE, stripeUserId: "acct_g", disconnectedAt: 500 });
    const res = await post({ _action: "disconnect-stripe", connectionId: "c_gone" });
    expect(res.status).toBe(403);
  });
});

describe("PLANT 3: disconnect stamps the timestamp, leaves is_primary, and the readers stop seeing it", () => {
  it("the primary keeps is_primary set and gains disconnected_at, matching legacy", async () => {
    seedConnection({ id: "c_primary", accountId: ACTIVE, stripeUserId: "acct_p", isPrimary: true });

    const res = await post({ _action: "disconnect-stripe", connectionId: "c_primary" });

    expect(res.status).toBe(200);
    const row = connectionRow("c_primary");
    expect(row.disconnectedAt).not.toBeNull();
    // 333 ruled AGAINST promotion and against clearing the flag: legacy does
    // neither, so the flag survives and the readers filter instead.
    expect(row.isPrimary).toBe(1);
  });

  it("READER 1, the switcher, returns no Stripe id for the account once disconnected", async () => {
    seedConnection({ id: "c_primary", accountId: ACTIVE, stripeUserId: "acct_p", isPrimary: true });
    const before = await listSwitcherAccounts(db, await listMemberships(db, USER));
    expect(before.find((a) => a.id === ACTIVE)?.stripeUserId).toBe("acct_p");

    await post({ _action: "disconnect-stripe", connectionId: "c_primary" });

    const after = await listSwitcherAccounts(db, await listMemberships(db, USER));
    expect(after.find((a) => a.id === ACTIVE)?.stripeUserId).toBeNull();
  });

  it("READER 2, the recovery connection query, already filtered and still does", async () => {
    const source = readFileSync(
      fileURLToPath(new URL("../app/lib/recovery/queries.server.ts", import.meta.url)),
      "utf8",
    );
    // Measured: this reader ALREADY carried the filter before 333, so it is the
    // one of the three that needed no change. Pinned so it cannot lose it.
    const block = source.slice(source.indexOf("isPrimary, true"), source.indexOf("isPrimary, true") + 200);
    expect(block).toContain("isNull(stripeConnections.disconnectedAt)");
  });

  it("READER 3, the admin Primary badge, is gated at the render", async () => {
    const source = readFileSync(
      fileURLToPath(new URL("../app/routes/admin/merchants/detail.tsx", import.meta.url)),
      "utf8",
    );
    // Gated in the render and not the query on purpose: that view lists
    // disconnected connections deliberately, as its audit trail.
    expect(source).toContain("c.isPrimary && !c.disconnectedAt");
  });

  it("the last connection leaves the account with none live, and the loader renders the empty state", async () => {
    seedConnection({ id: "c_only", accountId: ACTIVE, stripeUserId: "acct_o", isPrimary: true });

    await post({ _action: "disconnect-stripe", connectionId: "c_only" });

    const loaded = (await loader({ context: ctx, request: new Request("https://x/settings"), params: {} } as never)) as {
      connections: unknown[];
      everConnected: boolean;
    };
    expect(loaded.connections).toEqual([]);
    // It knows the difference between never-connected and disconnected.
    expect(loaded.everConnected).toBe(true);
  });
});

describe("PLANT 4: one batch, and a deauthorize failure never rolls the local write back", () => {
  it("the OAuth revoke runs AFTER the local commit, once, for that connection", async () => {
    seedConnection({ id: "c_a", accountId: ACTIVE, stripeUserId: "acct_a", isPrimary: true });
    seedConnection({ id: "c_b", accountId: ACTIVE, stripeUserId: "acct_b", connectedAt: 2_000 });

    await post({ _action: "disconnect-stripe", connectionId: "c_b" });

    expect(harness.deauthorizeCalls).toEqual(["acct_b"]);
    expect(connectionRow("c_b").disconnectedAt).not.toBeNull();
    // The sibling is untouched: one connection per request.
    expect(connectionRow("c_a").disconnectedAt).toBeNull();
  });

  it("a failed revoke leaves the connection disconnected and surfaces a warning", async () => {
    seedConnection({ id: "c_a", accountId: ACTIVE, stripeUserId: "acct_a", isPrimary: true });
    harness.deauthorizeOk = false;

    const res = await post({ _action: "disconnect-stripe", connectionId: "c_a" });

    // ok stays true: the merchant asked to disconnect and IS disconnected. The
    // revoke is a retriable follow-up, which is what deauthorizeConnectedAccount's
    // own comment binds.
    expect(res.body.ok).toBe(true);
    expect(connectionRow("c_a").disconnectedAt).not.toBeNull();
    expect(String(res.body.warning)).toContain("Stripe dashboard");
    expect(String(res.body.warning)).not.toMatch(new RegExp("[" + String.fromCharCode(0x2014, 0x2013) + "]"));
  });

  it("the write is a plain batch and never the money DO", async () => {
    const source = readFileSync(
      fileURLToPath(new URL("../app/lib/admin/merchants.server.ts", import.meta.url)),
      "utf8",
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).toContain("buildDisconnectConnectionBatch");
    // 333: one writer, one atomicity. If this module ever reaches for the DO,
    // stripe_connections gains a second writer with different guarantees.
    expect(code).not.toContain("executeMoneyWrite");
  });
});

describe("PLANT 5: cancel stops processing, disconnects all, and leaves billing alone", () => {
  it("stamps cancelled_at, disconnects every live connection, and moves the marker", async () => {
    seedConnection({ id: "c_a", accountId: ACTIVE, stripeUserId: "acct_a", isPrimary: true });
    seedConnection({ id: "c_b", accountId: ACTIVE, stripeUserId: "acct_b", connectedAt: 2_000 });

    const res = await post({ _action: "cancel-account" });

    expect(res.status).toBe(200);
    const acct = sqlite
      .prepare("SELECT cancelled_at AS c FROM accounts WHERE id = ?")
      .get(ACTIVE) as { c: number | null };
    expect(acct.c).not.toBeNull();
    expect(connectionRow("c_a").disconnectedAt).not.toBeNull();
    expect(connectionRow("c_b").disconnectedAt).not.toBeNull();
    expect(harness.deauthorizeCalls.sort()).toEqual(["acct_a", "acct_b"]);
    // The caller still holds the earliest account, so the session lands there.
    expect(markerOf("sess_1")).toBe(EARLIEST);
  });

  it("the processing gate now excludes the account, which is how recovery stops", async () => {
    seedConnection({ id: "c_a", accountId: ACTIVE, stripeUserId: "acct_a", isPrimary: true });

    const eligibleBefore = await db
      .select({ id: schema.accounts.id })
      .from(schema.accounts)
      .where(accountProcessingEligibleCondition());
    expect(eligibleBefore.map((r) => r.id)).toContain(ACTIVE);

    await post({ _action: "cancel-account" });

    const eligibleAfter = await db
      .select({ id: schema.accounts.id })
      .from(schema.accounts)
      .where(accountProcessingEligibleCondition());
    expect(eligibleAfter.map((r) => r.id)).not.toContain(ACTIVE);
    // The other account the caller holds is untouched.
    expect(eligibleAfter.map((r) => r.id)).toContain(EARLIEST);
  });

  it("BILLING IS UNTOUCHED: cancelled_at is a processing gate, never a billing gate", async () => {
    seedConnection({ id: "c_a", accountId: ACTIVE, stripeUserId: "acct_a", isPrimary: true });
    sqlite
      .prepare(
        "INSERT INTO failed_payments (id, account_id, stripe_event_id, stripe_invoice_id, stripe_customer_id, customer_email, amount_cents, currency, decline_category, status, detected_at) VALUES ('fp_1', ?, 'evt_1', 'in_1', 'cus_1', 'c@acme.test', 5000, 'usd', 'soft', 'active', 1000)",
      )
      .run(ACTIVE);
    sqlite
      .prepare(
        "INSERT INTO recovered_payments (id, account_id, failed_payment_id, amount_cents, currency, recovered_at, recovery_method, attribution_kind) VALUES ('rp_1', ?, 'fp_1', 5000, 'usd', 1000, 'email', 'foxhound_retry')",
      )
      .run(ACTIVE);

    await post({ _action: "cancel-account" });

    // The row PRICING rev 3 bills 20 percent on survives, which is exactly what
    // legacy's Delete account destroys via delete_account_cascade (333).
    const rows = sqlite.prepare("SELECT id FROM recovered_payments WHERE account_id = ?").all(ACTIVE);
    expect(rows).toHaveLength(1);
    const acctRow = sqlite
      .prepare("SELECT billing_exempt AS b FROM accounts WHERE id = ?")
      .get(ACTIVE) as { b: number };
    expect(acctRow.b).toBe(0);
  });

  it("with no other account held, the marker is left alone and the shell lands the empty state", async () => {
    sqlite.prepare("DELETE FROM account_members WHERE account_id = ?").run(EARLIEST);
    seedConnection({ id: "c_a", accountId: ACTIVE, stripeUserId: "acct_a", isPrimary: true });

    await post({ _action: "cancel-account" });

    expect(markerOf("sess_1")).toBe(ACTIVE);
    const remaining = await listMemberships(db, USER);
    expect(remaining.map((m) => m.accountId)).toEqual([ACTIVE]);
  });
});

describe("PLANT 6: the docs describe the control that now exists", () => {
  const DOCS = readFileSync(
    fileURLToPath(new URL("../app/lib/marketing/docs-content.ts", import.meta.url)),
    "utf8",
  );

  it("the disconnect promise is per connection, and no longer claims it stops everything", () => {
    // The sentence promised a Settings disconnect that did not exist, which is
    // the launch blocker S37 closes. It also claimed "Disconnecting stops every
    // active sequence immediately", and that went false the moment multi-account
    // shipped: a merchant holding two connected Stripe accounts keeps running on
    // the other one. Truthfulness fixes need no ratification (PRIME DIRECTIVE).
    expect(DOCS).toContain("from Settings inside Foxhound");
    expect(DOCS).toContain("one connected Stripe account at a time");
    expect(DOCS).not.toContain("stops every active sequence immediately");
    expect(DOCS).toContain("keeps running");
  });

  it("it does not let a merchant read disconnect as a way out of owed fees", () => {
    // cancelled_at is absent from app/db/billable.ts on purpose, so neither a
    // disconnect nor a cancel forgives matured, unbilled recoveries. PLANT 5
    // asserts that in the database; this asserts we say so.
    expect(DOCS).toContain("does not waive fees");
    expect(DOCS).toContain("still invoice");
    expect(DOCS).toContain("Danger zone");
  });
});

describe("PLANT 7: the demo firewall is untouched", () => {
  const SOURCE = readFileSync(
    fileURLToPath(new URL("../app/routes/app/settings/index.tsx", import.meta.url)),
    "utf8",
  );

  it("both S37 controls render inside DemoGuardedForm, like every other settings write", () => {
    // The hard refusal is appShellMiddleware's 405 on any non-GET for a demo
    // caller, which this session does not touch. DemoGuardedForm is the UX over
    // it, and using it keeps S37 identical to the five settings cards beside it.
    const stripeBlock = SOURCE.slice(SOURCE.indexOf("function StripeSection"), SOURCE.indexOf("function DangerZone"));
    const dangerBlock = SOURCE.slice(SOURCE.indexOf("function DangerZone"));
    expect(stripeBlock).toContain("<DemoGuardedForm method=\"post\"");
    expect(dangerBlock).toContain("<DemoGuardedForm method=\"post\"");
    expect(SOURCE).not.toContain("<Form method=\"post\"");
  });

  it("no demo constant or firewall helper is referenced here", () => {
    expect(SOURCE).not.toContain("DEMO_ACCOUNT_ID");
    expect(SOURCE).not.toContain("resolveDemoMembership");
  });
});
