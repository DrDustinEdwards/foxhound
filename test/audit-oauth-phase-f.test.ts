import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type Database from "better-sqlite3";
import type Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { resolveRateLimitBinding } from "~/lib/http/rate-limit";
import {
  ADD_ACCOUNT_ACTION,
  AUDIT_ACTION,
  CONNECT_ACTION,
  buildConnectState,
} from "~/lib/stripe/connect-state";
import {
  AUDIT_OAUTH_STATE_COOKIE,
  AUDIT_TOKEN_COOKIE,
  AUDIT_TOKEN_TTL_SECONDS,
  RATE_LIMIT_AUDIT,
  STRIPE_AUDIT_SCOPE,
  STRIPE_CONNECT_SCOPE,
} from "~/lib/constants";

import { createInMemoryDb } from "./helpers/inmemory-db";

// SESSION 71, PHASE (f): the anonymous read-only OAuth pair, and the door it
// opens onto the two surfaces phase (e) built.
//
// THE ASSERTION THIS FILE EXISTS FOR is one query parameter. 362 ruling 1 made
// the scope a ruling rather than a detail: legacy requests `read_write` for an
// audit that never writes, while four sentences either side of that request say
// read-only, so the copy is the intent and the code is the defect. PLANT 1 pins
// the parameter against the published sentence, in both directions.
//
// PLANTS DRIVE THE REAL LOADERS AND ACTIONS (352), against a real in-memory
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

const ROOT = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, ROOT)), "utf8");

/** Source with comments stripped, so an assertion cannot pass on a comment that
 *  EXPLAINS the thing it asserts is absent (session 57's lesson). */
const code = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

const ACCOUNT_A = "acct_alpha";
const ACCOUNT_B = "acct_beta";
const USER = "user_1";
const STRIPE_A = "acct_stripe_alpha";
const STRIPE_STRANGER = "acct_stripe_stranger";
const ORIGIN = "https://foxhoundapp.test";

const ENV = {
  STRIPE_CLIENT_ID: "ca_test_client",
  BETTER_AUTH_URL: ORIGIN,
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

function throwingList(message: string): AsyncIterable<never> {
  return {
    // eslint-disable-next-line require-yield
    async *[Symbol.asyncIterator]() {
      throw new Error(message);
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

// ---------------------------------------------------------------------------

describe("PLANT 1: THE SCOPE PARAMETER, which is the whole of 362 ruling 1", () => {
  it("the audit's authorize URL requests read_only, and NOT the onboarding scope", () => {
    const url = new URL(buildAuditAuthorizeUrl(ENV, buildConnectState(AUDIT_ACTION)));
    expect(url.searchParams.get("scope")).toBe("read_only");
    expect(url.searchParams.get("scope")).not.toBe(STRIPE_CONNECT_SCOPE);
    expect(url.searchParams.get("scope")).not.toBe("read_write");
    // Legacy's exact line for the record: `&scope=read_write`, at
    // app/api/audit/connect/route.ts:19.
    expect(url.toString()).not.toContain("scope=read_write");
    expect(url.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/audit/callback`);
  });

  it("THE PUBLISHED SENTENCE IS PINNED AGAINST THE REQUEST, in both directions", () => {
    // "The audit only reads." is on four Foxhound surfaces. Each is asserted
    // present AND the scope constant it describes is asserted read-only, so the
    // sentence and the parameter cannot drift apart in either direction: a scope
    // flipped back to read_write with the copy left standing fails here, and so
    // does the copy being quietly deleted to match a wider scope.
    expect(STRIPE_AUDIT_SCOPE).toBe("read_only");
    const carriers = [
      "app/routes/audit.tsx",
      "app/routes/products/audit.tsx",
      "app/lib/marketing/docs-content.ts",
    ];
    for (const path of carriers) {
      expect(read(path), `${path} lost the published sentence`).toContain(
        "The audit only reads",
      );
    }
    // And the consent screen's own three "can never" lines, which legacy printed
    // beside a read_write request. Under read-only all three are true.
    const consent = read("app/routes/audit/connect.tsx");
    expect(consent).toContain("Create new charges or move money");
    expect(consent).toContain("We need read-only access");
  });

  it("read_write is requested from EXACTLY ONE place, and it is merchant onboarding", () => {
    // DERIVED, so a second write-scope caller added later cannot arrive quietly.
    // Sweeps every module for a use of the onboarding scope constant and for the
    // raw literal, and requires the one legitimate site.
    const callers: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = `${dir}/${entry}`;
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry)) {
          const body = code(readFileSync(full, "utf8"));
          if (body.includes("STRIPE_CONNECT_SCOPE") || body.includes('"read_write"')) {
            callers.push(full.slice(full.indexOf("app/")).split("\\").join("/"));
          }
        }
      }
    };
    walk(fileURLToPath(new URL("app", ROOT)));
    expect(callers.sort()).toEqual([
      "app/lib/constants.ts",
      "app/lib/stripe/connect.ts",
      // /security DESCRIBES the two scopes to a reader and interpolates the
      // constants rather than typing "read_write", so it is a documentation
      // reference and not a request site (377 item 11). It is listed here rather
      // than excused by loosening the grep, and the assertion below keeps the
      // ruling's real subject intact: a prose page may name the scope, and may
      // never build an authorize URL.
      "app/routes/security.tsx",
    ]);
    expect(code(read("app/routes/security.tsx"))).not.toContain("buildConnectAuthorizeUrl");
    expect(code(read("app/routes/security.tsx"))).not.toContain("buildAuditAuthorizeUrl");
    // The audit's builder is the only caller of the read-only constant, so the
    // ruling has one enforcement point rather than one per route.
    expect(code(read("app/lib/stripe/connect.ts"))).toContain("STRIPE_AUDIT_SCOPE");
    expect(code(read("app/routes/audit/connect.tsx"))).toContain("buildAuditAuthorizeUrl");
  });
});

describe("PLANT 2: the start mints the audit's own state and cookie", () => {
  it("redirects to Stripe with a state that is byte-identical to the cookie", async () => {
    const response = (await connectRoute.action({
      request: new Request(`${ORIGIN}/audit/connect`, { method: "POST" }),
      context: routeContext(),
      params: {},
    } as never)) as Response;

    expect(response.status).toBe(302);
    const target = new URL(response.headers.get("Location")!);
    expect(target.origin + target.pathname).toBe("https://connect.stripe.com/oauth/authorize");
    expect(target.searchParams.get("scope")).toBe("read_only");

    const cookie = setCookies(response).find((c) => c.startsWith(AUDIT_OAUTH_STATE_COOKIE));
    expect(cookie).toBeDefined();
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    const cookieValue = decodeURIComponent(cookie!.split(";")[0].split("=").slice(1).join("="));
    expect(cookieValue).toBe(target.searchParams.get("state"));
    expect(JSON.parse(cookieValue).action).toBe(AUDIT_ACTION);
  });

  it("USES THE AUDIT COOKIE NAME, so a half-finished /connect is not clobbered", () => {
    // Legacy keeps `audit_oauth_state` separate from its merchant flow's cookie
    // and the separation is load-bearing: both flows can be in flight in one
    // browser, and a shared name means starting an audit silently invalidates
    // the other. This is the assertion that keeps them apart.
    expect(AUDIT_OAUTH_STATE_COOKIE).toBe("audit_oauth_state");
    expect(AUDIT_OAUTH_STATE_COOKIE).not.toBe("stripe_oauth_state");
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

  it("exchanges the code and sets legacy's five-minute token cookie", async () => {
    const state = buildConnectState(AUDIT_ACTION);
    const response = await call(
      { code: "ac_123", state },
      { [AUDIT_OAUTH_STATE_COOKIE]: state },
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(`/audit/results?account=${STRIPE_A}`);

    const token = setCookies(response).find((c) => c.startsWith(AUDIT_TOKEN_COOKIE));
    expect(token).toContain("HttpOnly");
    expect(token).toContain("Secure");
    expect(token).toContain("SameSite=Lax");
    // Legacy's exact semantics: 300 seconds, scoped to /audit.
    expect(token).toContain(`Max-Age=${AUDIT_TOKEN_TTL_SECONDS}`);
    expect(AUDIT_TOKEN_TTL_SECONDS).toBe(300);
    expect(token).toContain("Path=/audit");
    // And the state cookie is cleared on the way out.
    expect(setCookies(response).some((c) => c.includes(`${AUDIT_OAUTH_STATE_COOKIE}=;`))).toBe(true);

    // THE TOKEN IS NEVER IN THE URL, which is legacy's own comment and its
    // reason: history, logs, referrer.
    expect(response.headers.get("Location")).not.toContain("sk_live_audit_token");
    // AND IT IS IN NO TABLE, on either side.
    expect(
      sqlite.prepare("SELECT COUNT(*) AS n FROM stripe_connections").get() as { n: number },
    ).toEqual({ n: 1 });
  });

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

  it("REFUSES THE OTHER FLOWS' ACTIONS, so a connect grant cannot land here", async () => {
    for (const action of [CONNECT_ACTION, ADD_ACCOUNT_ACTION] as const) {
      const state = buildConnectState(action);
      const response = await call({ code: "ac_1", state }, { [AUDIT_OAUTH_STATE_COOKIE]: state });
      expect(response.headers.get("Location"), `${action} was accepted`).toBe(
        "/audit/connect?error=invalid_state",
      );
    }
  });

  it("AND /connect/callback REFUSES THE AUDIT'S, which is the other half", async () => {
    // The symmetry is the point: a read-only audit grant must not reach the
    // branch that attaches a connection or mints an account, and a read-write
    // onboarding grant must not be spent on an anonymous audit.
    const state = buildConnectState(AUDIT_ACTION);
    const response = (await connectCallback.loader({
      request: new Request(`${ORIGIN}/connect/callback?code=ac_1&state=${state}`, {
        headers: { Cookie: cookieHeader({ stripe_oauth_state: state }) },
      }),
      context: routeContext(),
      params: {},
    } as never)) as Response;
    expect(response.headers.get("Location")).toBe("/connect?error=invalid_state");
  });

  it("REFUSES A GRANT WIDER THAN READ-ONLY, rather than holding a write token", async () => {
    // The request parameter is half of 362 ruling 1; what Stripe GRANTS is the
    // other half, and legacy inspects neither. Fails closed.
    exchangeSpy.impl = async () => ({
      stripeUserId: STRIPE_A,
      accessToken: "sk_live_write_token",
      publishableKey: null,
      scope: "read_write",
    });
    const state = buildConnectState(AUDIT_ACTION);
    const response = await call({ code: "ac_1", state }, { [AUDIT_OAUTH_STATE_COOKIE]: state });
    expect(response.headers.get("Location")).toBe("/audit/connect?error=scope_refused");
    // No token cookie was set on the refusal path.
    expect(setCookies(response).some((c) => c.startsWith(AUDIT_TOKEN_COOKIE))).toBe(false);
  });

  it("a cancelled authorization comes back as cancelled, not as a failure", async () => {
    const response = await call({ error: "access_denied" }, {});
    expect(response.headers.get("Location")).toBe("/audit/connect?error=cancelled");
  });
});

describe("PLANT 4: the live results page, end to end", () => {
  const resultsRequest = (account: string | null, token: string | null) => {
    const url = new URL(`${ORIGIN}/audit/results`);
    if (account) url.searchParams.set("account", account);
    return new Request(url, {
      headers: token ? { Cookie: cookieHeader({ [AUDIT_TOKEN_COOKIE]: token }) } : {},
    });
  };

  const load = (account: string | null = STRIPE_A, token: string | null = "tok") =>
    resultsRoute.loader({
      request: resultsRequest(account, token),
      context: routeContext(),
      params: {},
    } as never);

  it("runs the engine over the real reads and renders the merchant's numbers", async () => {
    const data = (await load()) as Awaited<ReturnType<typeof resultsRoute.loader>>;
    expect(data.run.failedInvoices).toEqual({
      count: 1,
      totalCents: 4200,
      byCategory: expect.objectContaining({ soft: 4200 }),
    });
    expect(data.run.disputes?.open).toEqual({ count: 1, totalCents: 9900 });
    expect(data.run.lookbackDays).toBe(90);
    // No API key, so the summary is the fallback arm, present and usable.
    expect(data.run.summary).toBeTruthy();
  });

  it("A FAILED SCOPE ARRIVES AS null AND RENDERS AS A SENTENCE, never as a zero", async () => {
    harness.stripe = stripeWith({ disputes: { list: () => throwingList("stripe 500") } });
    const data = (await load()) as Awaited<ReturnType<typeof resultsRoute.loader>>;
    // The scope whose read failed is null; the ones that succeeded are not.
    expect(data.run.disputes).toBeNull();
    expect(data.run.failedInvoices).not.toBeNull();
    // A zero here would be indistinguishable from "no open disputes", which is
    // the lie 362 ruling 2 exists to stop.
    expect(data.run.disputes).not.toEqual({
      open: { count: 0, totalCents: 0 },
      acceptedWithoutFighting: { count: 0, totalCents: 0 },
      historical: { won: 0, lost: 0 },
    });
  });

  it("THE EXPIRED TOKEN IS REFUSED, with no Stripe call and no run", async () => {
    let called = false;
    harness.stripe = stripeWith({
      invoices: {
        list: () => {
          called = true;
          return fakeList([]);
        },
      },
    });
    // The cookie is gone (its five minutes elapsed); the account id alone is not
    // access, which is the property the Path=/audit cookie carries.
    await expect(load(STRIPE_A, null)).rejects.toMatchObject({
      status: 302,
      headers: expect.anything(),
    });
    // And the mirror case: a cookie with no account id.
    await expect(load(null, "tok")).rejects.toMatchObject({ status: 302 });
    expect(called).toBe(false);
    expect(runsInDb()).toHaveLength(0);
  });
});

describe("PLANT 5: what the anonymous path must never create", () => {
  const load = (account = STRIPE_A) =>
    resultsRoute.loader({
      request: new Request(`${ORIGIN}/audit/results?account=${account}`, {
        headers: { Cookie: cookieHeader({ [AUDIT_TOKEN_COOKIE]: "tok" }) },
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

  it("and the whole chain carries a no-write pin, module by module", () => {
    // The two pure modules already pin this; the three phase (f) files are where
    // a money write would have to be introduced to create a billable path off a
    // free audit, so each is swept. PRICING rev 3: the audit is free.
    for (const path of [
      "app/routes/audit/connect.tsx",
      "app/routes/audit/callback.ts",
      "app/lib/audit/run.server.ts",
    ]) {
      const body = code(read(path));
      for (const forbidden of [
        "recordOutcome",
        "executeMoneyWrite",
        "billingLineItems",
        "recoveredPayments",
        "findAttributionSignals",
        "saveAuditRun",
      ]) {
        expect(body, `${forbidden} reached ${path}`).not.toContain(forbidden);
      }
    }
    // The results page is the ONE file in the pair that may persist, and only
    // through saveAuditRun, which is a plain insert rather than a money write.
    const results = code(read("app/routes/audit/results.tsx"));
    expect(results).toContain("saveAuditRun");
    expect(results).not.toContain("executeMoneyWrite");
    expect(results).not.toContain("recordOutcome");
  });

  it("AND THE GRANT IS NEVER STORED, which is where legacy's token lives too", () => {
    // Legacy's `audit_access_token` occurs exactly twice in its tree: the
    // callback sets it, the results page reads it. Nothing encrypts it, nothing
    // writes it, and legacy never deauthorizes it either (`deauthorize` appears
    // nowhere in its repo). The cookie is the whole grant on both sides.
    const callbackSource = code(read("app/routes/audit/callback.ts"));
    expect(callbackSource).not.toContain("encryptToken");
    expect(callbackSource).not.toContain("stripeConnections");
    expect(callbackSource).not.toContain("getDb");
  });
});

describe("PLANT 6: a SIGNED-IN merchant running the anonymous flow", () => {
  const load = (account: string) =>
    resultsRoute.loader({
      request: new Request(`${ORIGIN}/audit/results?account=${account}`, {
        headers: { Cookie: cookieHeader({ [AUDIT_TOKEN_COOKIE]: "tok" }) },
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

  it("REFUSES TO FILE SOMEBODY ELSE'S NUMBERS INTO THEIR HISTORY, and says so", async () => {
    // Legacy files it regardless, so a merchant who audits a Stripe account they
    // do not hold gets that account's MRR, disputes and failed invoices in their
    // own history with nothing saying so. Ruled for Foxhound in session 71: the
    // results still render, the row is not written, and the page names the
    // reason. Same class as 356 binding 2 and 330 binding 2.
    signIn(ACCOUNT_A);
    const data = (await load(STRIPE_STRANGER)) as Awaited<
      ReturnType<typeof resultsRoute.loader>
    >;
    expect(data.notSaved).toBe("not_your_account");
    expect(runsInDb()).toHaveLength(0);
    // The numbers were still computed and are still shown.
    expect(data.run.failedInvoices?.totalCents).toBe(4200);
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

  it("a filed run reads its lookback from S30's column, through ONE reader", async () => {
    // The column the walk recorded as having no reader. 60 rather than the
    // default 90, so a hardcoded default cannot pass this.
    signIn(ACCOUNT_A);
    sqlite.prepare("UPDATE accounts SET audit_lookback_days = 60 WHERE id = ?").run(ACCOUNT_A);
    const data = (await load(STRIPE_A)) as Awaited<ReturnType<typeof resultsRoute.loader>>;
    expect(data.run.lookbackDays).toBe(60);
    expect(runsInDb()[0].lookback_days).toBe(60);
    // Not a second inline `?? 90`: the read goes through readAuditSettings, the
    // one named place deciding what NULL means for these columns.
    expect(code(read("app/routes/audit/results.tsx"))).not.toContain("auditLookbackDays");
    expect(code(read("app/lib/settings/audit-settings.server.ts"))).toContain("readAuditSettings");
  });
});

describe("PLANT 7: 311's rate limiter is USED, and UNCHANGED", () => {
  it("the limiter's own rule table is exactly what it was", () => {
    // 362 ruling 6 and this session's bounds: the limiter is used unchanged. The
    // audit pair therefore spends the EXISTING low-level check rather than
    // gaining a rule in the matcher, and this pins that the matcher did not move.
    const post = (path: string) =>
      resolveRateLimitBinding(new Request(`${ORIGIN}${path}`, { method: "POST" }));
    expect(post("/api/auth/x")).toEqual({ bucket: "auth", limit: 10, periodMs: 60_000 });
    expect(post("/audit")).toEqual({ bucket: "public", limit: 20, periodMs: 60_000 });
    expect(post("/demos")).toEqual({ bucket: "public", limit: 20, periodMs: 60_000 });
    // The audit pair gains NO entry here, and GET is still unmatched everywhere.
    expect(post("/audit/connect")).toBeNull();
    expect(post("/audit/callback")).toBeNull();
    expect(post("/audit/results")).toBeNull();
    expect(resolveRateLimitBinding(new Request(`${ORIGIN}/audit`))).toBeNull();
  });

  it("both audit routes check their own budget at legacy's numbers", () => {
    // Legacy IP-limits `audit-connect` and `audit-callback` at 10 per hour each.
    expect(RATE_LIMIT_AUDIT).toEqual({ max: 10, windowMs: 3_600_000 });
    for (const [path, bucket] of [
      ["app/routes/audit/connect.tsx", "audit-connect"],
      ["app/routes/audit/callback.ts", "audit-callback"],
    ] as const) {
      const body = code(read(path));
      expect(body, `${path} does not check the limiter`).toContain("isWithinRateLimit");
      expect(body, `${path} uses the wrong bucket`).toContain(`"${bucket}"`);
      expect(body, `${path} does not use legacy's numbers`).toContain("RATE_LIMIT_AUDIT");
      expect(body, `${path} keys on the wrong header`).toContain("cf-connecting-ip");
    }
  });

  it("a throttled start refuses without minting a state cookie", async () => {
    // Fail-open is the limiter's posture and legacy's; this drives the OVER-budget
    // arm, which is the one that has to actually stop something.
    const env = {
      ...ENV,
      RATE_LIMITER: {
        idFromName: () => "id",
        get: () => ({ check: async () => ({ allowed: false, retryAfterSec: 60 }) }),
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
