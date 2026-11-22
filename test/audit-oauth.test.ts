import type Database from "better-sqlite3";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { encryptToken } from "~/lib/stripe/encryption";
import { AUDIT_ACTION, buildConnectState } from "~/lib/stripe/connect-state";
import { readAuditGrantCookie } from "~/lib/stripe/state-cookie";
import {
  AUDIT_LOOKBACK_DAYS,
  AUDIT_OAUTH_STATE_COOKIE,
  AUDIT_TOKEN_COOKIE,
  AUDIT_TOKEN_TTL_SECONDS,
  STRIPE_AUDIT_SCOPE,
} from "~/lib/constants";

import { createInMemoryDb } from "./helpers/inmemory-db";

// The free audit's OAuth pair (/audit/connect, /audit/callback) and the door it
// opens onto the results page, through the real loaders and actions against an
// in-memory SQLite with the committed migrations. Two accounts and two Stripe
// accounts in every fixture, so a cross-tenant answer cannot pass by having
// nothing to be wrong about. The scope is read_write (Stripe gives read_only only
// to Extensions) and the grant's revoke is queued (test/audit-grant-revoke.test.ts).

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

const exchangeSpy = vi.hoisted(() => ({ impl: null as unknown, calls: 0 }));
vi.mock("~/lib/stripe/connect", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/stripe/connect")>();
  return {
    ...actual,
    exchangeConnectCode: (...args: unknown[]) => {
      exchangeSpy.calls += 1;
      return (exchangeSpy.impl as (...a: unknown[]) => unknown)(...args);
    },
  };
});

const connectRoute = await import("~/routes/audit/connect");
const callbackRoute = await import("~/routes/audit/callback");
const resultsRoute = await import("~/routes/audit/results");
const AuditConnect = connectRoute.default;
const connectCallback = await import("~/routes/auth/connect-callback");

const ACCOUNT_A = "acct_alpha";
const ACCOUNT_B = "acct_beta";
const USER = "user_1";
const TOKEN = "sk_live_audit_token";
const STRIPE_A = "acct_stripe_alpha";
const STRIPE_STRANGER = "acct_stripe_stranger";
const ORIGIN = "https://foxhoundapp.test";

const queued: Array<{ body: unknown; options: unknown }> = [];

const limiter = (allowed: boolean) => ({
  idFromName: () => "id",
  get: () => ({ hit: async () => ({ ok: allowed, retryAfterSeconds: 60 }) }),
});

const ENV = {
  STRIPE_CLIENT_ID: "ca_test_client",
  BETTER_AUTH_URL: ORIGIN,
  // The key the audit grant cookie is sealed under. Fake, test-only.
  ENCRYPTION_KEY: "0123456789abcdef".repeat(4),
  // The callback queues the grant's revoke here; nothing consumes it in this file.
  AUDIT_QUEUE: {
    send: async (body: unknown, options: unknown) => {
      queued.push({ body, options });
    },
  },
  RATE_LIMITER: limiter(true),
  // Deliberately no ANTHROPIC_API_KEY: the summary takes its fallback arm, which
  // makes every run in this file deterministic and proves the audit still
  // completes with the key core.md lists as a launch blocker still unfunded.
} as unknown as Env;

const routeContext = (env: Env = ENV): unknown => ({
  get: () => ({ env, ctx: {} as ExecutionContext }),
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
  exchangeSpy.calls = 0;
  queued.length = 0;
  exchangeSpy.impl = async () => ({
    stripeUserId: STRIPE_A,
    accessToken: TOKEN,
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

const setCookies = (response: Response): string[] => response.headers.getSetCookie();

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
    request: new Request(url, {
      headers: { Cookie: cookieHeader({ [AUDIT_OAUTH_STATE_COOKIE]: state }) },
    }),
    context: routeContext(),
    params: {},
  } as never)) as Response;
  exchangeSpy.impl = previous;
  const cookie = setCookies(response).find((c) => c.startsWith(`${AUDIT_TOKEN_COOKIE}=`));
  if (!cookie)
    throw new Error(`the callback set no token cookie (${response.headers.get("Location")})`);
  return cookie.split(";")[0].slice(AUDIT_TOKEN_COOKIE.length + 1);
}

describe("the start", () => {
  const start = async () =>
    (await connectRoute.action({
      request: new Request(`${ORIGIN}/audit/connect`, { method: "POST" }),
      context: routeContext(),
      params: {},
    } as never)) as Response;

  it("a GET loader sets no cookie and starts no flow", () => {
    const out = connectRoute.loader({
      request: new Request(`${ORIGIN}/audit/connect`),
      context: routeContext(),
      params: {},
    } as never);
    expect(out).not.toBeInstanceOf(Response);
  });

  it("the POST asks Stripe for read_write with a fresh state each time, in an HttpOnly cookie", async () => {
    const [a, b] = [await start(), await start()];
    const sa = new URL(a.headers.get("Location")!).searchParams;
    const sb = new URL(b.headers.get("Location")!).searchParams;
    expect(sa.get("scope")).toBe(STRIPE_AUDIT_SCOPE);
    expect(sa.get("scope")).toBe("read_write");
    expect(sa.get("redirect_uri")).toBe(`${ORIGIN}/audit/callback`);
    expect(sa.get("state")).not.toBe(sb.get("state"));
    const cookie = setCookies(a).find((c) => c.startsWith(`${AUDIT_OAUTH_STATE_COOKIE}=`))!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Max-Age=600/);
    // The cookie holds exactly the state Stripe will echo back, marked "audit", so
    // the callback can match it and refuse any other flow's.
    const value = decodeURIComponent(
      cookie.split(";")[0].slice(AUDIT_OAUTH_STATE_COOKIE.length + 1),
    );
    expect(value).toBe(sa.get("state"));
    expect(JSON.parse(value).action).toBe(AUDIT_ACTION);
  });

  it("the page never reflects an unknown error code from the query string", () => {
    const hostile = "<img src=x onerror=alert(1)>acct_stranger owned by Dana";
    const props = {
      loaderData: { lookbackDays: AUDIT_LOOKBACK_DAYS, stripeEnabled: true, error: hostile },
      params: {},
      matches: [],
    } as unknown as Parameters<typeof AuditConnect>[0];
    const router = createMemoryRouter(
      [{ path: "*", element: createElement(AuditConnect, props) }],
      { initialEntries: ["/audit/connect"] },
    );
    const html = renderToStaticMarkup(createElement(RouterProvider, { router }));
    expect(html).toContain("Could not connect Stripe. Please try again.");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("acct_stranger");
  });
});

describe("the callback refuses before it exchanges, and every exit clears the state", () => {
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

  const tokenOf = (response: Response) =>
    setCookies(response).find((c) => c.startsWith(`${AUDIT_TOKEN_COOKIE}=`));

  /** A refusal: back to the consent page with the code, the state cleared, no token. */
  function expectRefused(response: Response, reason: string) {
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(`/audit/connect?error=${reason}`);
    expect(
      setCookies(response).some(
        (c) => c.startsWith(`${AUDIT_OAUTH_STATE_COOKIE}=;`) && c.includes("Max-Age=0"),
      ),
    ).toBe(true);
    expect(tokenOf(response)).toBeUndefined();
  }

  const stateAndCall = (params: Record<string, string>, env: Env = ENV) => {
    const state = buildConnectState(AUDIT_ACTION);
    return callbackRoute.loader({
      request: callbackRequest({ ...params, state }, { [AUDIT_OAUTH_STATE_COOKIE]: state }),
      context: routeContext(env),
      params: {},
    } as never) as Promise<Response>;
  };

  it("over the rate limit: refused before anything else, never exchanged", async () => {
    const env = { ...ENV, RATE_LIMITER: limiter(false) } as unknown as Env;
    expectRefused(await stateAndCall({ code: "ac_1" }, env), "rate_limited");
    expect(exchangeSpy.calls).toBe(0);
  });

  it("Stripe's error and a missing code both come back as canceled", async () => {
    expectRefused(await stateAndCall({ error: "access_denied" }), "cancelled");
    expectRefused(await stateAndCall({}), "cancelled");
    expect(exchangeSpy.calls).toBe(0);
  });

  it("a grant with no scope at all is refused, fail closed", async () => {
    exchangeSpy.impl = async () => ({
      stripeUserId: STRIPE_A,
      accessToken: TOKEN,
      publishableKey: null,
      scope: null,
    });
    expectRefused(await stateAndCall({ code: "ac_1" }), "scope_refused");
  });

  it("a failed exchange is refused as failed, and nothing from it is logged", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    exchangeSpy.impl = async () => {
      throw new Error(`Stripe said no for ${TOKEN}`);
    };
    expectRefused(await stateAndCall({ code: "ac_1" }), "failed");
    for (const args of errorSpy.mock.calls)
      expect(JSON.stringify(args.map(String))).not.toContain(TOKEN);
  });

  it("success: a same-site relative redirect, the token only in a sealed five-minute /audit cookie, the revoke queued", async () => {
    const response = await stateAndCall({ code: "ac_1" });
    const location = response.headers.get("Location")!;
    expect(location).toBe(`/audit/results?account=${STRIPE_A}`);
    expect(location).not.toContain(TOKEN);
    const token = tokenOf(response)!;
    expect(token).toMatch(/; Path=\/audit; Secure; HttpOnly; SameSite=Lax; Max-Age=300$/);
    // Sealed: the value never carries the token in plain text, and it opens to
    // exactly the grant this callback was given.
    const value = token.split(";")[0].slice(AUDIT_TOKEN_COOKIE.length + 1);
    expect(decodeURIComponent(value)).not.toContain(TOKEN);
    const grant = await readAuditGrantCookie(
      ENV,
      new Request(`${ORIGIN}/audit/results`, {
        headers: { Cookie: `${AUDIT_TOKEN_COOKIE}=${value}` },
      }),
    );
    expect(grant).toEqual({ accessToken: TOKEN, stripeAccountId: STRIPE_A });
    expect(setCookies(response).some((c) => c.startsWith(`${AUDIT_OAUTH_STATE_COOKIE}=;`))).toBe(
      true,
    );
    // The revoke is queued for when the window ends, carrying the account id and never the token.
    expect(queued).toEqual([
      {
        body: { kind: "audit-grant-revoke", stripeAccountId: STRIPE_A },
        options: { delaySeconds: 300 },
      },
    ]);
  });

  it("a state that does not match the cookie is refused before anything is exchanged", async () => {
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

  it("/connect/callback refuses the audit's state, and the audit refuses its", async () => {
    // An anonymous audit grant must not reach the branch that attaches a
    // connection or mints an account.
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

  it("a missing ENCRYPTION_KEY fails closed with one fixed log line and no secret", async () => {
    const logged: unknown[][] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });
    const env = { ...ENV, ENCRYPTION_KEY: undefined } as unknown as Env;
    const state = buildConnectState(AUDIT_ACTION);
    const url = new URL(`${ORIGIN}/audit/callback`);
    url.searchParams.set("code", "ac_1");
    url.searchParams.set("state", state);
    const response = (await callbackRoute.loader({
      request: new Request(url, {
        headers: { Cookie: cookieHeader({ [AUDIT_OAUTH_STATE_COOKIE]: state }) },
      }),
      context: routeContext(env),
      params: {},
    } as never)) as Response;

    expect(response.headers.get("Location")).toBe("/audit/connect?error=failed");
    expect(setCookies(response).some((c) => c.startsWith(`${AUDIT_TOKEN_COOKIE}=`))).toBe(false);
    // Exactly one line, a fixed string, carrying neither the token nor the id.
    expect(logged).toEqual([["audit grant seal failed: check ENCRYPTION_KEY"]]);
  });
});

describe("what the anonymous path must never create", () => {
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

  it("creates no account, membership, connection, outcome, billing row or run", async () => {
    // Measured before and after, so a write anywhere in the chain shows up as a delta.
    const before = counts();
    const data = (await load()) as Awaited<ReturnType<typeof resultsRoute.loader>>;
    expect(data.signedIn).toBe(false);
    expect(data.notSaved).toBe("anonymous");
    expect(counts()).toEqual(before);
  });
});

describe("a signed-in merchant running the anonymous flow", () => {
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

  it("the second account is not a loophole: the active account decides", async () => {
    // This user owns both accounts. Signed in ON ACCOUNT B, auditing the Stripe
    // account live on ACCOUNT A must not file into B: `held_by_caller` is asked
    // with the ACTIVE account alone, not with every account the caller holds.
    signIn(ACCOUNT_B);
    const data = (await load(STRIPE_A)) as Awaited<ReturnType<typeof resultsRoute.loader>>;
    expect(data.notSaved).toBe("not_your_account");
    expect(runsInDb()).toHaveLength(0);
  });
});

describe("the audited account is the one Stripe named, never the query's", () => {
  // The query's `?account=` is editable: a merchant signed in on ACCOUNT_A who
  // authorized a stranger's Stripe account could swap the id to STRIPE_A and have
  // the stranger's numbers filed into ACCOUNT_A's history.
  const load = (account: string, grant: string) =>
    resultsRoute.loader({
      request: new Request(`${ORIGIN}/audit/results?account=${account}`, {
        headers: { Cookie: cookieHeader({ [AUDIT_TOKEN_COOKIE]: grant }) },
      }),
      context: routeContext(),
      params: {},
    } as never);

  it("a grant for one account with another account's id in the URL runs nothing and saves nothing", async () => {
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
    expect(
      runsInDb().map((r) => [r.account_id, r.stripe_account_id, r.failed_invoices_cents]),
    ).toEqual([]);
    expect(called).toBe(false);
    // Refused the way an expired link is, naming nobody.
    expect(outcome).toBeInstanceOf(Response);
    expect((outcome as Response).headers.get("Location")).toBe(
      "/audit/connect?error=invalid_state",
    );
  });

  it("sealed JSON that is not an audit grant is refused, even under the same key", async () => {
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

  it("a grant older than the cookie's five minutes is refused by the server too", async () => {
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

describe("the start and the callback are rate limited", () => {
  it("a throttled start refuses without minting a state cookie", async () => {
    const env = { ...ENV, RATE_LIMITER: limiter(false) } as unknown as Env;
    const response = (await connectRoute.action({
      request: new Request(`${ORIGIN}/audit/connect`, { method: "POST" }),
      context: routeContext(env),
      params: {},
    } as never)) as Response;
    expect(response.headers.get("Location")).toBe("/audit/connect?error=rate_limited");
    expect(setCookies(response).some((c) => c.startsWith(AUDIT_OAUTH_STATE_COOKIE))).toBe(false);
  });
});
