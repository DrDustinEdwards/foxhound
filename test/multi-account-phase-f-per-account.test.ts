import type Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";

import { createInMemoryDb } from "./helpers/inmemory-db";

// MULTI-ACCOUNT PHASE (f), ruling 326: every authenticated surface renders the
// ACTIVE account and nothing else.
//
// THE METHOD IS A DIFFERENTIAL, NOT A FIELD-BY-FIELD AUDIT, and that is what
// makes it a complete blend detector. Each loader is rendered twice as the SAME
// account: once in a database where a SECOND account holds a full set of rows,
// and once in a database where that second account does not exist at all. If
// the two renders are identical, then nothing anywhere in that loader's chain
// saw the second account: not the main query, not a stat card, not a badge
// count, not a secondary widget three helpers deep. A per-field assertion can
// only catch the fields somebody thought to name; this catches the whole chain.
//
// The second account's rows are deliberately LARGER and MORE NUMEROUS than the
// first's, so any leak moves a number rather than happening to agree.
//
// 352's two-account rule, applied to renders rather than to a single query.

const NOW = Date.parse("2026-08-23T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

const A = "acct_alpha";
const B = "acct_beta";
const USER = "user_1";

const harness = vi.hoisted(() => ({ db: null as unknown }));
const sessionHarness = vi.hoisted(() => ({ session: null as unknown }));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

vi.mock("~/lib/auth/session", () => ({ getSession: async () => sessionHarness.session }));

const dashboard = await import("~/routes/app/dashboard");
const recoveryIndex = await import("~/routes/app/recovery/index");
const payments = await import("~/routes/app/recovery/payments/index");
const sequences = await import("~/routes/app/recovery/sequences");
const winback = await import("~/routes/app/recovery/winback");
const expiringCards = await import("~/routes/app/recovery/expiring-cards");
const disputesIndex = await import("~/routes/app/disputes/index");
const billing = await import("~/routes/app/billing/index");
const settingsHub = await import("~/routes/app/settings/hub");
const settingsTeam = await import("~/routes/app/settings/team");
const settingsApiKeys = await import("~/routes/app/settings/api-keys");
const settingsNotifications = await import("~/routes/app/settings/notifications");
const settingsBrandVoice = await import("~/routes/app/settings/brand-voice");
const settingsEmail = await import("~/routes/app/settings/email");
const settingsAccount = await import("~/routes/app/settings/account");
const settingsAudit = await import("~/routes/app/settings/audit");
const settingsAlerts = await import("~/routes/app/settings/alerts");
const settingsFeatures = await import("~/routes/app/settings/features");
const settingsStripe = await import("~/routes/app/settings/stripe");
const intelligenceIndex = await import("~/routes/app/intelligence/index");
const intelligenceCustomers = await import("~/routes/app/intelligence/customers");
const intelligenceChurn = await import("~/routes/app/intelligence/churn");
const intelligenceAlerts = await import("~/routes/app/intelligence/alerts");
const intelligenceReports = await import("~/routes/app/intelligence/reports");

let sqlite: Database.Database;

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterAll(() => {
  vi.useRealTimers();
});

/** Every authenticated surface with a loader, by the name it is reported under. */
const SURFACES: { name: string; run: (ctx: unknown, url: string) => Promise<unknown> }[] = [
  { name: "dashboard", run: (c) => call(dashboard.loader, c, "/dashboard") },
  { name: "recovery/index", run: (c) => call(recoveryIndex.loader, c, "/recovery") },
  { name: "recovery/payments", run: (c) => call(payments.loader, c, "/recovery/payments") },
  { name: "recovery/sequences", run: (c) => call(sequences.loader, c, "/recovery/sequences") },
  { name: "recovery/winback", run: (c) => call(winback.loader, c, "/recovery/winback") },
  {
    name: "recovery/expiring-cards",
    run: (c) => call(expiringCards.loader, c, "/recovery/expiring-cards"),
  },
  { name: "disputes/index", run: (c) => call(disputesIndex.loader, c, "/disputes") },
  { name: "billing/index", run: (c) => call(billing.loader, c, "/billing") },
  { name: "settings/hub", run: (c) => call(settingsHub.loader, c, "/settings") },
  { name: "settings/team", run: (c) => call(settingsTeam.loader, c, "/settings/team") },
  { name: "settings/api-keys", run: (c) => call(settingsApiKeys.loader, c, "/settings/api-keys") },
  {
    name: "settings/notifications",
    run: (c) => call(settingsNotifications.loader, c, "/settings/notifications"),
  },
  {
    name: "settings/brand-voice",
    run: (c) => call(settingsBrandVoice.loader, c, "/settings/brand-voice"),
  },
  { name: "settings/email", run: (c) => call(settingsEmail.loader, c, "/settings/email") },
  { name: "settings/account", run: (c) => call(settingsAccount.loader, c, "/settings/account") },
  { name: "settings/audit", run: (c) => call(settingsAudit.loader, c, "/settings/audit") },
  { name: "settings/alerts", run: (c) => call(settingsAlerts.loader, c, "/settings/alerts") },
  { name: "settings/features", run: (c) => call(settingsFeatures.loader, c, "/settings/features") },
  { name: "settings/stripe", run: (c) => call(settingsStripe.loader, c, "/settings/stripe") },
  { name: "intelligence/index", run: (c) => call(intelligenceIndex.loader, c, "/intelligence") },
  {
    name: "intelligence/customers",
    run: (c) => call(intelligenceCustomers.loader, c, "/intelligence/customers"),
  },
  { name: "intelligence/churn", run: (c) => call(intelligenceChurn.loader, c, "/intelligence/churn") },
  {
    name: "intelligence/alerts",
    run: (c) => call(intelligenceAlerts.loader, c, "/intelligence/alerts"),
  },
  {
    name: "intelligence/reports",
    run: (c) => call(intelligenceReports.loader, c, "/intelligence/reports"),
  },
];

const detailRoutes = {
  payment: await import("~/routes/app/recovery/payments/detail"),
  dispute: await import("~/routes/app/disputes/detail"),
  invoice: await import("~/routes/app/billing/invoice"),
  customer: await import("~/routes/app/intelligence/customer"),
};

/** The four id-bearing detail routes, keyed on the ACTING account's own row.
 *  `px` is that account's row-id prefix, which is how each surface asks for its
 *  own data rather than a hardcoded id that would only exist for one of them. */
const DETAIL_SURFACES: {
  name: string;
  run: (ctx: unknown, px: string) => Promise<unknown>;
}[] = [
  {
    name: "recovery/payments/:id",
    run: (c, px) => callWithParams(detailRoutes.payment.loader, c, { id: `fp_${px}_1` }),
  },
  {
    name: "disputes/:id",
    run: (c, px) => callWithParams(detailRoutes.dispute.loader, c, { id: `dsp_${px}_1` }),
  },
  {
    name: "billing/invoices/:id",
    run: (c, px) => callWithParams(detailRoutes.invoice.loader, c, { id: `inv_${px}_1` }),
  },
  {
    name: "intelligence/customers/:id",
    run: (c, px) => callWithParams(detailRoutes.customer.loader, c, { id: `cus_${px}_1` }),
  },
];

async function callWithParams(
  loader: unknown,
  context: unknown,
  params: Record<string, string>,
): Promise<unknown> {
  return (loader as (a: unknown) => Promise<unknown>)({
    context,
    request: new Request("https://foxhoundapp.test/detail"),
    params,
  });
}

async function call(loader: unknown, context: unknown, path: string): Promise<unknown> {
  return (loader as (a: unknown) => Promise<unknown>)({
    context,
    request: new Request(`https://foxhoundapp.test${path}`),
    params: {},
  });
}

function contextFor(accountId: string, accountName: string): unknown {
  return {
    get(key: unknown) {
      if (key === cloudflareContext) {
        return { env: {} as Env, ctx: { waitUntil() {} } as unknown as ExecutionContext, nonce: "n" };
      }
      if (key === authContext) {
        return {
          userId: USER,
          userName: USER,
          email: "owner@alpha.test",
          membership: { memberId: `m_${accountId}`, accountId, accountName, role: "owner" },
          memberships: [
            { memberId: "m_a", accountId: A, accountName: "Alpha Ltd", role: "owner" },
            { memberId: "m_b", accountId: B, accountName: "Beta Ltd", role: "owner" },
          ],
          activeAccountId: accountId,
          isAdmin: false,
          isDemo: false,
          demoSignedIn: false,
        };
      }
      throw new Error("unexpected context key");
    },
  };
}

/** Seed one account's whole footprint. `mag` scales every magnitude and `rows`
 *  every count, so account B is never mistakable for account A. */
function seed(accountId: string, name: string, mag: number, rows: number): void {
  const px = accountId.slice(5, 9);
  sqlite
    .prepare(
      "INSERT INTO accounts (id, name, created_at, theme, notification_email, digest_enabled, slack_notifications_enabled, audit_lookback_days, audit_auto_run, winback_notifications_enabled, expiring_card_notifications_enabled, merchant_industry, primary_customer_type, mrr_estimate_cents, onboarding_completed) VALUES (?, ?, ?, ?, ?, 1, 1, ?, 1, ?, ?, ?, ?, ?, 1)",
    )
    .run(
      accountId,
      name,
      1_000,
      mag === 1 ? "dark" : "light",
      `alerts+${px}@test.test`,
      30 * mag,
      // The two feature toggles differ BY ACCOUNT, so /settings/features is
      // genuinely exercised by the differential rather than reporting the same
      // pair of booleans either way.
      mag === 1 ? 1 : 0,
      mag === 1 ? 0 : 1,
      `industry ${px}`,
      `customers ${px}`,
      50_000 * mag,
    );

  sqlite
    .prepare(
      "INSERT INTO account_members (id, account_id, user_id, role, status, created_at) VALUES (?, ?, ?, 'owner', 'active', 1000)",
    )
    .run(`m_${px}`, accountId, USER);

  sqlite
    .prepare(
      "INSERT INTO stripe_connections (id, account_id, stripe_user_id, stripe_access_token, is_primary, name, sender_name, brand_voice, connected_at, created_at) VALUES (?, ?, ?, 'enc', 1, ?, ?, ?, ?, ?)",
    )
    .run(`conn_${px}`, accountId, `acct_stripe_${px}`, `Conn ${px}`, `Sender ${px}`, `voice of ${px}`, 1_000, 1_000);

  sqlite
    .prepare(
      "INSERT INTO account_subscriptions (id, account_id, product, status, created_at) VALUES (?, ?, 'intelligence', 'active', 1000)",
    )
    .run(`sub_${px}`, accountId);

  for (let i = 1; i <= rows; i++) {
    const fpId = `fp_${px}_${i}`;
    sqlite
      .prepare(
        "INSERT INTO failed_payments (id, account_id, stripe_connection_id, stripe_event_id, stripe_invoice_id, stripe_customer_id, customer_email, customer_name, amount_cents, currency, decline_category, status, detected_at, is_renewal_noise) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'usd', 'soft', ?, ?, 0)",
      )
      .run(
        fpId,
        accountId,
        `conn_${px}`,
        `evt_${px}_${i}`,
        `in_${px}_${i}`,
        `cus_${px}_${i}`,
        `payer${i}@${px}.test`,
        `Payer ${px} ${i}`,
        1_000 * mag * i,
        i === 1 ? "recovered" : "active",
        NOW - 5 * DAY,
      );

    sqlite
      .prepare(
        "INSERT INTO recovery_steps (id, account_id, failed_payment_id, step_type, step_number, scheduled_at, executed_at, result) VALUES (?, ?, ?, 'email_day1', 1, ?, ?, 'email_sent')",
      )
      .run(`${fpId}_s1`, accountId, fpId, NOW - 4 * DAY, NOW - 4 * DAY);

    if (i === 1) {
      sqlite
        .prepare(
          "INSERT INTO recovered_payments (id, account_id, failed_payment_id, recovered_at, amount_cents, currency, recovery_method, recovery_trigger, attribution_kind, recovered_by_step_id) VALUES (?, ?, ?, ?, ?, 'usd', 'retry', 'retry', 'foxhound_retry', ?)",
        )
        .run(
          `rp_${px}_${i}`,
          accountId,
          fpId,
          NOW - 40 * DAY,
          1_000 * mag * i,
          `${fpId}_s1`,
        );
    }

    sqlite
      .prepare(
        "INSERT INTO disputes (id, account_id, stripe_dispute_id, stripe_charge_id, stripe_customer_id, customer_name, amount_cents, currency, reason, status, state, evidence_deadline, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'usd', 'fraudulent', 'needs_response', 'pending_review', ?, ?)",
      )
      .run(
        `dsp_${px}_${i}`,
        accountId,
        `dp_${px}_${i}`,
        `ch_${px}_${i}`,
        `cus_${px}_${i}`,
        `Disputer ${px} ${i}`,
        5_000 * mag,
        NOW + 3 * DAY,
        NOW - DAY,
      );

    sqlite
      .prepare(
        "INSERT INTO customer_context (id, account_id, stripe_customer_id, customer_name, customer_email, health_score, mrr_contribution_cents, currency, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'usd', ?, ?)",
      )
      .run(
        `cc_${px}_${i}`,
        accountId,
        `cus_${px}_${i}`,
        `Payer ${px} ${i}`,
        `payer${i}@${px}.test`,
        20 * mag + i,
        900 * mag * i,
        NOW - 10 * DAY,
        NOW - DAY,
      );

    sqlite
      .prepare(
        "INSERT INTO expiring_card_alerts (id, account_id, stripe_connection_id, stripe_customer_id, customer_email, customer_name, expires_month, expires_year, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        `card_${px}_${i}`,
        accountId,
        `conn_${px}`,
        `cus_card_${px}_${i}`,
        `card${i}@${px}.test`,
        `CardHolder ${px} ${i}`,
        9,
        2026,
        NOW - DAY,
      );

    sqlite
      .prepare(
        "INSERT INTO win_back_sequences (id, account_id, stripe_connection_id, stripe_subscription_id, stripe_customer_id, customer_email, customer_name, plan_name, amount_cents, currency, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'usd', 'active', ?)",
      )
      .run(
        `wb_${px}_${i}`,
        accountId,
        `conn_${px}`,
        `sub_stripe_${px}_${i}`,
        `cus_${px}_${i}`,
        `payer${i}@${px}.test`,
        `Payer ${px} ${i}`,
        `Plan ${px}`,
        4_000 * mag * i,
        NOW - 20 * DAY,
      );

    sqlite
      .prepare(
        "INSERT INTO alerts (id, account_id, metric, direction, threshold_value, channel, label, enabled, created_at) VALUES (?, ?, 'recovery_rate', 'below', ?, 'email', ?, 1, ?)",
      )
      .run(`al_${px}_${i}`, accountId, 10 * mag + i, `Alert ${px} ${i}`, NOW - DAY);

    sqlite
      .prepare(
        "INSERT INTO api_keys (id, account_id, label, key_hash, scope, created_at) VALUES (?, ?, ?, ?, 'mcp_merchant', ?)",
      )
      .run(`key_${px}_${i}`, accountId, `Key ${px} ${i}`, `hash_${px}_${i}`, NOW - DAY);

    sqlite
      .prepare(
        "INSERT INTO billing_invoices (id, account_id, period_start, period_end, status, total_cents, currency, idempotency_key, created_at) VALUES (?, ?, ?, ?, 'open', ?, 'usd', ?, ?)",
      )
      .run(`inv_${px}_${i}`, accountId, NOW - 31 * DAY, NOW - DAY, 2_000 * mag * i, `idem_${px}_${i}`, NOW - DAY);

    sqlite
      .prepare(
        "INSERT INTO billing_line_items (id, account_id, invoice_id, type, amount_cents, fee_cents, currency, recovered_payment_id, description, created_at) VALUES (?, ?, ?, 'recovery_fee', ?, ?, 'usd', ?, ?, ?)",
      )
      .run(
        `li_${px}_${i}`,
        accountId,
        `inv_${px}_${i}`,
        1_000 * mag * i,
        200 * mag * i,
        i === 1 ? `rp_${px}_${i}` : null,
        `Recovery fee ${px} ${i}`,
        NOW - DAY,
      );

    sqlite
      .prepare(
        "INSERT INTO intelligence_reports (id, account_id, report_month, narrative, generated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(`rep_${px}_${i}`, accountId, `2026-0${i}`, `Narrative for ${px} ${i}`, NOW - DAY);

    sqlite
      .prepare(
        "INSERT INTO audit_runs (id, account_id, run_at, lookback_days, failed_invoices_cents, open_disputes_cents, currency, created_at) VALUES (?, ?, ?, 90, ?, ?, 'usd', ?)",
      )
      .run(`aud_${px}_${i}`, accountId, NOW - 2 * DAY, 7_000 * mag, 3_000 * mag, NOW - 2 * DAY);
  }
}

/** Render every surface as `accountId`. `withOther` decides whether the OTHER
 *  account exists in the database AT ALL, which is the whole experiment: if a
 *  loader's output moves when a stranger's rows appear, some query in its chain
 *  is unscoped. */
async function renderAll(accountId: string, withOther: boolean): Promise<Record<string, string>> {
  const fresh = createInMemoryDb();
  sqlite = fresh.sqlite;
  harness.db = fresh.db;

  // The acting account is always seeded identically. The other one is bigger and
  // has more rows, so a leak moves a number rather than coinciding with one.
  if (accountId === A) {
    seed(A, "Alpha Ltd", 1, 2);
    if (withOther) seed(B, "Beta Ltd", 7, 3);
  } else {
    seed(B, "Beta Ltd", 7, 3);
    if (withOther) seed(A, "Alpha Ltd", 1, 2);
  }

  const out: Record<string, string> = {};
  const ctx = contextFor(accountId, accountId === A ? "Alpha Ltd" : "Beta Ltd");
  for (const surface of SURFACES) {
    out[surface.name] = JSON.stringify(await surface.run(ctx, ""));
  }
  const px = accountId.slice(5, 9);
  for (const surface of DETAIL_SURFACES) {
    out[surface.name] = JSON.stringify(await surface.run(ctx, px));
  }
  return out;
}

const ALL_SURFACE_NAMES = [...SURFACES, ...DETAIL_SURFACES].map((s) => s.name);

describe("PHASE (f): every surface renders the active account and nothing else", () => {
  it("SEEDS BOTH ACCOUNTS FOR REAL, so an empty-fixture pass is impossible", async () => {
    // 259's data-dependent zero. Two renders of two empty databases are also
    // identical, and would pass every assertion below while proving nothing.
    const withB = await renderAll(A, true);
    expect(Object.keys(withB)).toHaveLength(ALL_SURFACE_NAMES.length);
    expect(withB["dashboard"]).toContain("recoveryRatePct");
    expect(withB["settings/team"]).toContain("m_alph");
    expect(withB["recovery/payments"]).toContain("Payer alph");
    expect(
      (sqlite.prepare("SELECT COUNT(*) AS n FROM failed_payments").get() as { n: number }).n,
    ).toBe(5);
  });

  const cases = [
    { actor: A, label: "Alpha" },
    { actor: B, label: "Beta" },
  ];

  for (const { actor, label } of cases) {
    it(`renders identically for ${label} whether or not the other account exists`, async () => {
      const withOther = await renderAll(actor, true);
      const alone = await renderAll(actor, false);

      const blended = ALL_SURFACE_NAMES.filter((n) => withOther[n] !== alone[n]);
      // Named surfaces in the failure message, so a blend reports WHICH page
      // rather than a wall of JSON.
      expect(blended).toEqual([]);
    });
  }

  it("the two accounts genuinely render DIFFERENT numbers, which is the both-directions half", async () => {
    // Without this, a loader that returned a constant would pass every
    // assertion above. A coverage test whose expected set derives from the
    // thing under test proves nothing; this pins that the surfaces are live.
    const asA = await renderAll(A, true);
    const asB = await renderAll(B, true);
    const same = ALL_SURFACE_NAMES.filter((n) => asA[n] === asB[n]);
    expect(same).toEqual([]);
  });
});

// ---------------------------------------------------------------- JOB 3
//
// THE SWITCH, END TO END. Everything above renders a hand-built context. This
// drives the REAL switch action from session 36, then rebuilds the context the
// way `appShellMiddleware` does (listMemberships plus resolveActiveMembershipFrom
// off the session's own marker), so nothing about which account is active is
// asserted by the test rather than by the code.

const { action: switchAction } = await import("~/routes/api/account-switch");
const { listMemberships, resolveActiveMembershipFrom } = await import("~/lib/auth/account");
const { resolveThemeForRequest } = await import("~/lib/theme.server");

const SESSION_ID = "sess_switch";

describe("PHASE (f) JOB 3: switching accounts moves every surface", () => {
  it("renders A, switches, and every surface then renders B", async () => {
    const fresh = createInMemoryDb();
    sqlite = fresh.sqlite;
    harness.db = fresh.db;
    sqlite
      .prepare("INSERT INTO user (id, name, email, email_verified, updated_at) VALUES (?, ?, ?, 0, 0)")
      .run(USER, USER, "owner@alpha.test");
    seed(A, "Alpha Ltd", 1, 2);
    seed(B, "Beta Ltd", 7, 3);
    sqlite
      .prepare(
        "INSERT INTO session (id, expires_at, token, updated_at, user_id, active_account_id) VALUES (?, ?, ?, 0, ?, NULL)",
      )
      .run(SESSION_ID, 9_999_999_999_999, "tok_switch", USER);
    sessionHarness.session = sessionFor(null);

    // Marker null: the chokepoint's fallback is the earliest membership, which
    // is Alpha. Nothing here says "Alpha"; the resolver does.
    const before = await renderFromSession();
    expect(before.accountId).toBe(A);
    await expect(resolveThemeForRequest({} as Env, signedInRequest())).resolves.toBe("dark");

    const response = await switchAction({
      request: switchRequest(B),
      context: contextFor(A, "Alpha Ltd"),
      params: {},
    } as never);
    expect((response as Response).status).toBe(302);
    sessionHarness.session = sessionFor(markerOf());

    const after = await renderFromSession();
    expect(after.accountId).toBe(B);

    // EVERY surface moved. Asserting a handful of stats would leave the rest
    // unproven, so this asserts the whole render set changed and that none of
    // it still matches what Alpha saw.
    const unchanged = ALL_SURFACE_NAMES.filter((n) => before.render[n] === after.render[n]);
    expect(unchanged).toEqual([]);

    // And the theme follows the account, which is 356's ratified fix reaching
    // the surface it was ratified for.
    await expect(resolveThemeForRequest({} as Env, signedInRequest())).resolves.toBe("light");

    // The refusal half: the switch action must not honour an account the caller
    // does not hold, or the whole per-account story is decoration.
    const refused = await switchAction({
      request: switchRequest("acct_not_theirs"),
      context: contextFor(B, "Beta Ltd"),
      params: {},
    } as never);
    expect((refused as Response).status).toBe(403);
    expect(markerOf()).toBe(B);
  });
});

function markerOf(): string | null {
  const row = sqlite
    .prepare("SELECT active_account_id AS m FROM session WHERE id = ?")
    .get(SESSION_ID) as { m: string | null } | undefined;
  return row?.m ?? null;
}

function sessionFor(activeAccountId: string | null): unknown {
  return {
    user: { id: USER, name: USER, email: "owner@alpha.test" },
    session: { id: SESSION_ID, activeAccountId },
  };
}

function signedInRequest(): Request {
  const headers = new Headers();
  headers.set("Cookie", "better-auth.session_token=tok_switch");
  return new Request("https://foxhoundapp.test/dashboard", { headers });
}

function switchRequest(accountId: string): Request {
  const form = new FormData();
  form.append("accountId", accountId);
  return new Request("https://foxhoundapp.test/api/account/switch", {
    method: "POST",
    body: form,
    headers: { referer: "https://foxhoundapp.test/dashboard" },
  });
}

/** Rebuild the context the way appShellMiddleware does, then render everything. */
async function renderFromSession(): Promise<{ accountId: string; render: Record<string, string> }> {
  const db = harness.db as Parameters<typeof listMemberships>[0];
  const memberships = await listMemberships(db, USER);
  const membership = await resolveActiveMembershipFrom(db, memberships, markerOf());
  if (!membership) throw new Error("no membership resolved");
  const ctx = contextFor(membership.accountId, membership.accountName ?? "");
  const render: Record<string, string> = {};
  for (const surface of SURFACES) {
    render[surface.name] = JSON.stringify(await surface.run(ctx, ""));
  }
  const px = membership.accountId.slice(5, 9);
  for (const surface of DETAIL_SURFACES) {
    render[surface.name] = JSON.stringify(await surface.run(ctx, px));
  }
  return { accountId: membership.accountId, render };
}

describe("PHASE (f): the id-bearing routes refuse the OTHER account's ids", () => {
  it("404s on every detail route when the id belongs to the other account", async () => {
    // The differential proves a detail route does not BLEND. This proves it does
    // not SERVE: an id is caller-supplied, so a route that scoped its summary
    // query and not its detail query would pass the differential and still hand
    // one merchant another's invoice.
    await renderAll(A, true);
    const ctx = contextFor(A, "Alpha Ltd");
    const beta = B.slice(5, 9);

    for (const surface of DETAIL_SURFACES) {
      let status: number | string = "resolved";
      try {
        const result = await surface.run(ctx, beta);
        // intelligence/customer returns a value rather than throwing when it is
        // not entitled, so a resolved value is only acceptable if it carries no
        // detail at all.
        status = JSON.stringify(result);
      } catch (thrown) {
        status = thrown instanceof Response ? thrown.status : "threw";
      }
      expect(status, `${surface.name} served a foreign id`).toBe(404);
    }
  });
});

describe("PHASE (f): the app shell, the ONE surface that must see other accounts", () => {
  it("keeps everything per-account EXCEPT the switcher list, which is the point of it", async () => {
    // The differential's rule is inverted here on purpose. `listSwitcherAccounts`
    // exists to render the accounts a caller can switch TO, so its output MUST
    // change when a second account exists. Everything else the shell loads
    // (account name, nav context, theme) must not.
    const appShell = await import("~/layouts/app-shell");

    const render = async (withOther: boolean) => {
      const fresh = createInMemoryDb();
      sqlite = fresh.sqlite;
      harness.db = fresh.db;
      seed(A, "Alpha Ltd", 1, 2);
      if (withOther) seed(B, "Beta Ltd", 7, 3);
      sessionHarness.session = null;
      const memberships = withOther
        ? [
            { memberId: "m_a", accountId: A, accountName: "Alpha Ltd", role: "owner" },
            { memberId: "m_b", accountId: B, accountName: "Beta Ltd", role: "owner" },
          ]
        : [{ memberId: "m_a", accountId: A, accountName: "Alpha Ltd", role: "owner" }];
      const ctx = {
        get(key: unknown) {
          if (key === cloudflareContext) {
            return {
              env: {} as Env,
              ctx: { waitUntil() {} } as unknown as ExecutionContext,
              nonce: "n",
            };
          }
          return {
            userId: USER,
            userName: USER,
            email: "owner@alpha.test",
            membership: memberships[0],
            memberships,
            activeAccountId: A,
            isAdmin: false,
            isDemo: false,
            demoSignedIn: false,
          };
        },
      };
      return (await call(appShell.loader, ctx, "/dashboard")) as Record<string, unknown>;
    };

    const withB = await render(true);
    const alone = await render(false);

    // The switcher list is the deliberate exception, and it really does move.
    expect((withB.accounts as unknown[]).length).toBe(2);
    expect((alone.accounts as unknown[]).length).toBe(1);

    // Everything else is identical, which is the same differential as above
    // applied to the one surface that has to be carved out of it.
    // readAt is when the loader ran, for the page bar's "Updated ..." line: a
    // clock reading, not account data, so it differs between any two calls.
    const strip = (r: Record<string, unknown>) =>
      JSON.stringify(Object.fromEntries(Object.entries(r).filter(([k]) => k !== "accounts" && k !== "readAt")));
    expect(strip(withB)).toBe(strip(alone));
  });
});
