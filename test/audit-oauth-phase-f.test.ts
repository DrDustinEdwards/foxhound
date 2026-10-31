import type Database from "better-sqlite3";
import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveRateLimitBinding } from "~/lib/http/rate-limit";
import { encryptToken } from "~/lib/stripe/encryption";
import {
  AUDIT_ACTION,
  buildConnectState,
} from "~/lib/stripe/connect-state";
import { AUDIT_OAUTH_STATE_COOKIE, AUDIT_TOKEN_COOKIE, AUDIT_TOKEN_TTL_SECONDS, STRIPE_AUDIT_SCOPE } from "~/lib/constants";

import { createInMemoryDb } from "./helpers/inmemory-db";

// SESSION 71, PHASE (f): the anonymous audit's OAuth pair, and the door it
// opens onto the two surfaces phase (e) built.
//
// PLANT 1 pins the scope the audit asks for. 362 ruling 1 made it read_only;
// on 2026-10-29 Stripe refused read_only in production (only Extensions may use
// it), so it is read_write again and Foxhound revokes the grant when the window
// ends (test/audit-grant-revoke.test.ts). The plant that pinned the old
// "Read-only" copy against the scope went with it.
//
// PLANTS DRIVE THE REAL LOADERS AND ACTIONS, against a real in-memory
// SQLite with the committed migrations applied, with two accounts and two Stripe
// accounts in the fixture so a cross-tenant answer cannot pass by having nothing
// to be wrong about.

const harness = vi.hoisted(() => ({
  db: null as unknown,
  session: null as unknown,
  stripe: null as unknown,
}));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

vi.mock("~/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/auth")>()),
  getSession: async () => harness.session,
}));

// The one live seam. `getConnectedStripe` is what turns the audit's cookie into
// a client; everything downstream of it is the real reads module, the real pure
// engine and the real persistence.
vi.mock("~/lib/stripe/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/stripe/client")>()),
  getConnectedStripe: () => harness.stripe,
}));

const exchangeSpy = vi.hoisted(() => ({ impl: null as unknown }));
vi.mock("~/lib/stripe/connect", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/stripe/connect")>();
  return {
    ...actual,
    exchangeConnectCode: (...args: unknown[]) =>
      (exchangeSpy.impl as (...a: unknown[]) => unknown)(...args),
  };
});

const { buildAuditAuthorizeUrl } = await import("~/lib/stripe/connect");
const connectRoute = await import("~/routes/audit/connect");
const callbackRoute = await import("~/routes/audit/callback");
const resultsRoute = await import("~/routes/audit/results");
const connectCallback = await import("~/routes/auth/connect-callback");

const ACCOUNT_A = "acct_alpha";
const ACCOUNT_B = "acct_beta";
const USER = "user_1";
const STRIPE_A = "acct_stripe_alpha";
const STRIPE_STRANGER = "acct_stripe_stranger";
const ORIGIN = "https://foxhoundapp.test";

const ENV = {
  STRIPE_CLIENT_ID: "ca_test_client",
  BETTER_AUTH_URL: ORIGIN,
  // The key the audit grant cookie is sealed under. Fake, test-only.
  ENCRYPTION_KEY: "0123456789abcdef".repeat(4),
  // The callback queues the grant's revoke here; nothing consumes it in this file.
  AUDIT_QUEUE: { send: async () => {} },
  // Deliberately no ANTHROPIC_API_KEY: the summary takes its fallback arm, which
  // makes every run in this file deterministic and proves the audit still
  // completes with the key core.md lists as a launch blocker still unfunded.
} as unknown as Env;

const routeContext = (env: Env = ENV): unknown => ({
  get: () => ({ env, ctx: {} as ExecutionContext, nonce: "n" }),
});

function fakeList<T>(items: T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of items) yield item;
    },
  };
}

const INVOICE = {
  amount_due: 4200,
  currency: "usd",
  status: "uncollectible",
  last_finalization_error: { decline_code: "insufficient_funds" },
} as unknown as Stripe.Invoice;

const DISPUTE = {
  amount: 9900,
  currency: "usd",
  status: "needs_response",
} as unknown as Stripe.Dispute;

/** A Stripe client whose five audit reads answer. `over` replaces one list with
 *  a throwing one, which is how a single failed scope is driven end to end. */
function stripeWith(over: Record<string, unknown> = {}) {
  return {
    invoices: { list: () => fakeList([INVOICE]) },
    subscriptions: { list: () => fakeList([]) },
    disputes: { list: () => fakeList([DISPUTE]) },
    events: { list: () => fakeList([]) },
    ...over,
  } as unknown as Stripe;
}

let sqlite: Database.Database;

beforeEach(() => {
  const made = createInMemoryDb();
  sqlite = made.sqlite;
  harness.db = made.db;
  harness.session = null;
  harness.stripe = stripeWith();
  exchangeSpy.impl = async () => ({
    stripeUserId: STRIPE_A,
    accessToken: "sk_live_audit_token",
    publishableKey: null,
    scope: STRIPE_AUDIT_SCOPE,
  });

  for (const id of [ACCOUNT_A, ACCOUNT_B]) {
    sqlite.prepare("INSERT INTO accounts (id, name, created_at) VALUES (?, ?, 1000)").run(id, id);
    sqlite
      .prepare(
        "INSERT INTO account_members (id, account_id, user_id, role, status, created_at) VALUES (?, ?, ?, 'owner', 'active', 1000)",
      )
      .run(`m_${id}`, id, USER);
  }
  // STRIPE_A is live on ACCOUNT_A. STRIPE_STRANGER is live nowhere.
  sqlite
    .prepare(
      "INSERT INTO stripe_connections (id, account_id, stripe_user_id, stripe_access_token, is_primary, connected_at, created_at) VALUES ('sc_a', ?, ?, 'enc', 1, 1000, 1000)",
    )
    .run(ACCOUNT_A, STRIPE_A);
});

function signIn(activeAccountId: string) {
  harness.session = {
    user: { id: USER, name: "Owner", email: "owner@alpha.test" },
    session: { id: "sess_1", activeAccountId },
  };
}

const cookieHeader = (parts: Record<string, string>) =>
  Object.entries(parts)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");

/** Every Set-Cookie a Response carries, since the callback sets two. */
const setCookies = (response: Response): string[] =>
  typeof (response.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie ===
  "function"
    ? (response.headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
    : [response.headers.get("Set-Cookie") ?? ""];

const runsInDb = () =>
  sqlite.prepare("SELECT * FROM audit_runs").all() as Record<string, unknown>[];

/** Where a loader that must refuse sent the visitor. Fails if it did not throw
 *  a redirect, so a resolved page cannot pass as a refusal. */
async function refusedTo(pending: Promise<unknown>): Promise<string | null> {
  try {
    await pending;
  } catch (thrown) {
    if (thrown instanceof Response) return thrown.headers.get("Location");
    throw thrown;
  }
  return "resolved: no refusal";
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** The token cookie's value exactly as the REAL callback sets it after Stripe
 *  answered with `stripeUserId`, so every results test holds a grant the
 *  product actually minted rather than a hand-typed one. */
async function mintGrant(stripeUserId: string = STRIPE_A): Promise<string> {
  const previous = exchangeSpy.impl;
  exchangeSpy.impl = async () => ({
    stripeUserId,
    accessToken: `sk_live_audit_token_${stripeUserId}`,
    publishableKey: null,
    scope: STRIPE_AUDIT_SCOPE,
  });
  const state = buildConnectState(AUDIT_ACTION);
  const url = new URL(`${ORIGIN}/audit/callback`);
  url.searchParams.set("code", "ac_mint");
  url.searchParams.set("state", state);
  const response = (await callbackRoute.loader({
    request: new Request(url, { headers: { Cookie: cookieHeader({ [AUDIT_OAUTH_STATE_COOKIE]: state }) } }),
    context: routeContext(),
    params: {},
  } as never)) as Response;
  exchangeSpy.impl = previous;
  const cookie = setCookies(response).find((c) => c.startsWith(`${AUDIT_TOKEN_COOKIE}=`));
  if (!cookie) throw new Error(`the callback set no token cookie (${response.headers.get("Location")})`);
  return cookie.split(";")[0].slice(AUDIT_TOKEN_COOKIE.length + 1);
}

// ---------------------------------------------------------------------------

describe("PLANT 1: THE SCOPE PARAMETER", () => {
  it("the audit's authorize URL requests read_write, the one scope Stripe gives a platform", () => {
    const url = new URL(buildAuditAuthorizeUrl(ENV, buildConnectState(AUDIT_ACTION)));
    expect(url.searchParams.get("scope")).toBe(STRIPE_AUDIT_SCOPE);
    expect(STRIPE_AUDIT_SCOPE).toBe("read_write");
    expect(url.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/audit/callback`);
  });
});

describe("PLANT 3: the callback, and what it refuses", () => {
  const callbackRequest = (params: Record<string, string>, cookies: Record<string, string>) => {
    const url = new URL(`${ORIGIN}/audit/callback`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return new Request(url, { headers: { Cookie: cookieHeader(cookies) } });
  };

  const call = (params: Record<string, string>, cookies: Record<string, string>) =>
    callbackRoute.loader({
      request: callbackRequest(params, cookies),
      context: routeContext(),
      params: {},
    } as never) as Promise<Response>;

  it("REFUSES A STATE THAT DOES NOT MATCH THE COOKIE, before exchanging anything", async () => {
    let exchanged = false;
    exchangeSpy.impl = async () => {
      exchanged = true;
      throw new Error("must not be reached");
    };
    const response = await call(
      { code: "ac_123", state: buildConnectState(AUDIT_ACTION) },
      { [AUDIT_OAUTH_STATE_COOKIE]: buildConnectState(AUDIT_ACTION) },
    );
    expect(response.headers.get("Location")).toBe("/audit/connect?error=invalid_state");
    expect(exchanged).toBe(false);
  });

  it("AND /connect/callback REFUSES THE AUDIT'S, which is the other half", async () => {
    // The symmetry is the point: an anonymous audit grant must not reach the
    // branch that attaches a connection or mints an account, and a read-write
    // onboarding grant must not be spent on an anonymous audit.
    const state = buildConnectState(AUDIT_ACTION);
    const response = (await connectCallback.loader({
      request: new Request(`${ORIGIN}/connect/callback?code=ac_1&state=${state}`, {
        headers: { Cookie: cookieHeader({ "__Host-stripe_oauth_state": state }) },
      }),
      context: routeContext(),
      params: {},
    } as never)) as Response;
    expect(response.headers.get("Location")).toBe("/connect?error=invalid_state");
  });

  it("A MISSING ENCRYPTION_KEY fails closed with one fixed log line and no secret", async () => {
    const logged: unknown[][] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });
    // A limiter that answers, so its own fail-open line is not in the log.
    const env = {
      ...ENV,
      ENCRYPTION_KEY: undefined,
      RATE_LIMITER: {
        idFromName: () => "id",
        get: () => ({ hit: async () => ({ ok: true, retryAfterSeconds: 0 }) }),
      },
    } as unknown as Env;
    const state = buildConnectState(AUDIT_ACTION);
    const url = new URL(`${ORIGIN}/audit/callback`);
    url.searchParams.set("code", "ac_1");
    url.searchParams.set("state", state);
    const response = (await callbackRoute.loader({
      request: new Request(url, { headers: { Cookie: cookieHeader({ [AUDIT_OAUTH_STATE_COOKIE]: state }) } }),
      context: routeContext(env),
      params: {},
    } as never)) as Response;

    expect(response.headers.get("Location")).toBe("/audit/connect?error=failed");
    expect(setCookies(response).some((c) => c.startsWith(`${AUDIT_TOKEN_COOKIE}=`))).toBe(false);
    // Exactly one line, a fixed string, carrying neither the token nor the id.
    expect(logged).toEqual([["audit grant seal failed: check ENCRYPTION_KEY"]]);
  });
});

describe("PLANT 5: what the anonymous path must never create", () => {
  const load = async (account = STRIPE_A) =>
    resultsRoute.loader({
      request: new Request(`${ORIGIN}/audit/results?account=${account}`, {
        headers: { Cookie: cookieHeader({ [AUDIT_TOKEN_COOKIE]: await mintGrant(account) }) },
      }),
      context: routeContext(),
      params: {},
    } as never);

  const counts = () => ({
    accounts: (sqlite.prepare("SELECT COUNT(*) AS n FROM accounts").get() as { n: number }).n,
    members: (sqlite.prepare("SELECT COUNT(*) AS n FROM account_members").get() as { n: number }).n,
    connections: (
      sqlite.prepare("SELECT COUNT(*) AS n FROM stripe_connections").get() as { n: number }
    ).n,
    outcomes: (sqlite.prepare("SELECT COUNT(*) AS n FROM outcomes").get() as { n: number }).n,
    lineItems: (
      sqlite.prepare("SELECT COUNT(*) AS n FROM billing_line_items").get() as { n: number }
    ).n,
    runs: runsInDb().length,
  });

  it("NO ACCOUNT, NO MEMBERSHIP, NO CONNECTION, NO OUTCOME, NO BILLING ROW, NO RUN", async () => {
    // Legacy mints no account-ish record for an anonymous audit either: its
    // callback touches no table and its results page inserts only inside
    // `if (isAuthenticated && accountRowId)`. Measured against the real schema,
    // before and after, so a write anywhere in the chain shows up as a delta.
    const before = counts();
    const data = (await load()) as Awaited<ReturnType<typeof resultsRoute.loader>>;
    expect(data.signedIn).toBe(false);
    expect(data.notSaved).toBe("anonymous");
    expect(counts()).toEqual(before);
  });
});

describe("PLANT 6: a SIGNED-IN merchant running the anonymous flow", () => {
  const load = async (account: string) =>
    resultsRoute.loader({
      request: new Request(`${ORIGIN}/audit/results?account=${account}`, {
        headers: { Cookie: cookieHeader({ [AUDIT_TOKEN_COOKIE]: await mintGrant(account) }) },
      }),
      context: routeContext(),
      params: {},
    } as never);

  it("files the run when the audited Stripe account is the one they hold", async () => {
    signIn(ACCOUNT_A);
    const data = (await load(STRIPE_A)) as Awaited<ReturnType<typeof resultsRoute.loader>>;
    expect(data.notSaved).toBeNull();

    const rows = runsInDb();
    expect(rows).toHaveLength(1);
    expect(rows[0].account_id).toBe(ACCOUNT_A);
    expect(rows[0].stripe_account_id).toBe(STRIPE_A);
    expect(rows[0].is_authenticated).toBe(1);
    expect(rows[0].failed_invoices_cents).toBe(4200);
  });

  it("AND THE SECOND ACCOUNT IS NOT A LOOPHOLE, which the ACTIVE account decides", async () => {
    // This user owns both accounts. Signed in ON ACCOUNT B, auditing the Stripe
    // account live on ACCOUNT A must not file into B: `held_by_caller` is asked
    // with the ACTIVE account alone, not with every account the caller holds.
    signIn(ACCOUNT_B);
    const data = (await load(STRIPE_A)) as Awaited<ReturnType<typeof resultsRoute.loader>>;
    expect(data.notSaved).toBe("not_your_account");
    expect(runsInDb()).toHaveLength(0);
  });
});

describe("PLANT 6b: the audited account is the one STRIPE named, never the query's", () => {
  // The callback learns the Stripe account id from Stripe's own token response.
  // The results page used to take it from `?account=`, which the visitor can
  // edit, while the token in the cookie still read the account that granted it.
  // A merchant signed in on ACCOUNT_A who authorized a STRANGER's Stripe account
  // could change the id to STRIPE_A, and the stranger's numbers were filed into
  // ACCOUNT_A's history under STRIPE_A.
  const load = (account: string, grant: string) =>
    resultsRoute.loader({
      request: new Request(`${ORIGIN}/audit/results?account=${account}`, {
        headers: { Cookie: cookieHeader({ [AUDIT_TOKEN_COOKIE]: grant }) },
      }),
      context: routeContext(),
      params: {},
    } as never);

  it("A GRANT FOR ONE ACCOUNT WITH ANOTHER ACCOUNT'S ID IN THE URL runs nothing and saves nothing", async () => {
    signIn(ACCOUNT_A);
    const strangersGrant = await mintGrant(STRIPE_STRANGER);
    let called = false;
    harness.stripe = stripeWith({
      invoices: {
        list: () => {
          called = true;
          return fakeList([INVOICE]);
        },
      },
    });

    let outcome: unknown;
    try {
      outcome = await load(STRIPE_A, strangersGrant);
    } catch (thrown) {
      outcome = thrown;
    }

    // No row under either id, and no Stripe read under the stranger's token.
    expect(runsInDb().map((r) => [r.account_id, r.stripe_account_id, r.failed_invoices_cents])).toEqual([]);
    expect(called).toBe(false);
    // Refused the way an expired link is, naming nobody.
    expect(outcome).toBeInstanceOf(Response);
    expect((outcome as Response).headers.get("Location")).toBe("/audit/connect?error=invalid_state");
  });

  it("SEALED JSON THAT IS NOT AN AUDIT GRANT is refused, even under the same key", async () => {
    // Another sealer under ENCRYPTION_KEY producing the same {t, a} shape must
    // never be accepted here: the grant carries a checked purpose.
    signIn(ACCOUNT_A);
    const now = Date.now();
    for (const payload of [
      { t: "sk_live_other", a: STRIPE_A, iat: now },
      { p: "something-else", t: "sk_live_other", a: STRIPE_A, iat: now },
    ]) {
      const forged = await encryptToken(ENV, JSON.stringify(payload));
      expect(await refusedTo(load(STRIPE_A, forged)), JSON.stringify(payload)).toBe(
        "/audit/connect?error=session_expired",
      );
    }
    expect(runsInDb()).toHaveLength(0);
  });

  it("A GRANT OLDER THAN THE COOKIE'S FIVE MINUTES is refused by the server too", async () => {
    // Max-Age is the browser's promise; a cookie copied out of the browser keeps
    // no such promise, so the seal carries its own issue time.
    signIn(ACCOUNT_A);
    const grant = await mintGrant(STRIPE_A);
    const issued = Date.now();

    const at = vi.spyOn(Date, "now");
    at.mockReturnValue(issued + AUDIT_TOKEN_TTL_SECONDS * 1000 + 1000);
    expect(await refusedTo(load(STRIPE_A, grant))).toBe("/audit/connect?error=session_expired");
    expect(runsInDb()).toHaveLength(0);

    // Inside the window it is still a grant, so the refusal above is the clock.
    at.mockReturnValue(issued + (AUDIT_TOKEN_TTL_SECONDS - 10) * 1000);
    const data = (await load(STRIPE_A, grant)) as Awaited<ReturnType<typeof resultsRoute.loader>>;
    expect(data.notSaved).toBeNull();
  });
});

describe("PLANT 7: 311's rate limiter is USED, and UNCHANGED", () => {
  it("the limiter's own rule table is exactly what it was", () => {
    // 362 ruling 6 and this session's bounds: the limiter is used unchanged. The
    // audit pair therefore spends the EXISTING low-level check rather than
    // gaining a rule in the matcher, and this pins that the matcher did not move.
    const post = (path: string) =>
      resolveRateLimitBinding(new Request(`${ORIGIN}${path}`, { method: "POST" }));
    // The auth bucket left this matcher for site-runtime's limiter inside the
    // auth actions; the public bucket is what remains, unchanged.
    expect(post("/api/auth/x")).toBeNull();
    expect(post("/audit")).toEqual({ bucket: "public", limit: 20, periodMs: 60_000 });
    expect(post("/demos")).toEqual({ bucket: "public", limit: 20, periodMs: 60_000 });
    // The audit pair gains NO entry here, and GET is still unmatched everywhere.
    expect(post("/audit/connect")).toBeNull();
    expect(post("/audit/callback")).toBeNull();
    expect(post("/audit/results")).toBeNull();
    expect(resolveRateLimitBinding(new Request(`${ORIGIN}/audit`))).toBeNull();
  });

  it("a throttled start refuses without minting a state cookie", async () => {
    // Fail-open is the limiter's posture and legacy's; this drives the OVER-budget
    // arm, which is the one that has to actually stop something.
    const env = {
      ...ENV,
      RATE_LIMITER: {
        idFromName: () => "id",
        get: () => ({ hit: async () => ({ ok: false, retryAfterSeconds: 60 }) }),
      },
    } as unknown as Env;
    const response = (await connectRoute.action({
      request: new Request(`${ORIGIN}/audit/connect`, { method: "POST" }),
      context: routeContext(env),
      params: {},
    } as never)) as Response;
    expect(response.headers.get("Location")).toBe("/audit/connect?error=rate_limited");
    expect(setCookies(response).some((c) => c.startsWith(AUDIT_OAUTH_STATE_COOKIE))).toBe(false);
  });
});
