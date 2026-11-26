import type Database from "better-sqlite3";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { createInMemoryDb, inMemoryMoneyWriter } from "./helpers/inmemory-db";

// THE PRETEND MERCHANT, END TO END. One merchant connected to a simulated Stripe goes through the
// whole path on the real code with no injected seams: a card declines, the sequence runs its
// retries and emails, the customer updates the card and pays, a second customer never pays and the
// sequence ends, and the dashboard and billing read the result. Only Stripe, the mail binding and
// the clock are stand-ins. Each `it` runs on the state the one before left.

const harness = vi.hoisted(() => ({
  db: null as unknown,
  sent: [] as { from: string; to: string; subject: string; html: string }[],
  stripeCalls: [] as string[],
  stripe: null as unknown,
  bouncing: new Set<string>(),
}));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

vi.mock("~/lib/stripe/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/stripe/client")>()),
  getStripe: () => harness.stripe,
  getConnectedStripe: () => harness.stripe,
}));

const { processConnectedWebhook } = await import("~/lib/webhooks/process");
const { encryptToken } = await import("~/lib/stripe/encryption");
const { runRecoveryTick } = await import("~/lib/cron/recovery-tick");
const click = await import("~/routes/utility/engagement-click");
const cardUpdate = await import("~/routes/utility/card-update");
const { cloudflareContext } = await import("@dustinedwards/site-runtime/context");
const { MERCHANT_TOOLS } = await import("~/lib/mcp/tools.server");

/** What the merchant sees: their own read tools, the same answers the dashboard reads. */
async function merchantSees(tool: string, args: Record<string, unknown> = {}) {
  const now = new Date(sim.now);
  return MERCHANT_TOOLS.get(tool)!.execute(
    { env, db: harness.db as never, accountId: ACCOUNT, now, trace: { apiKeyId: "k", tool, now } },
    args,
  ) as Promise<Record<string, unknown>>;
}

const ORIGIN = "https://foxhoundapp.test";
const routeContext = {
  get(key: unknown) {
    if (key === cloudflareContext) return { env, ctx: { waitUntil: () => {} } };
    throw new Error("unexpected context key");
  },
};

/** Run a route loader or action the way the Worker does, returning a thrown redirect as the
 *  response it is. */
async function route(
  fn: (args: never) => unknown,
  url: string,
  params: Record<string, string>,
  method = "GET",
): Promise<{ status: number; location: string | null; data: unknown }> {
  let out: unknown;
  try {
    out = await fn({
      request: new Request(url, { method }),
      params,
      context: routeContext,
    } as never);
  } catch (thrown) {
    out = thrown;
  }
  if (out instanceof Response) {
    return { status: out.status, location: out.headers.get("Location"), data: null };
  }
  const d = out as { data?: unknown; init?: { status?: number } };
  return { status: d.init?.status ?? 200, location: null, data: d.data ?? out };
}

const day1Emails: { to: string; subject: string; html: string }[] = [];

function buttonHref(html: string): string {
  const m = /class="e-btn" href="([^"]+)"/.exec(html);
  if (!m) throw new Error("email has no button");
  return m[1].replace(/&amp;/g, "&");
}

/** The five-minute cron at a moment of the simulated clock. */
async function tickAt(at: number) {
  sim.now = at;
  vi.setSystemTime(at);
  return runRecoveryTick(env);
}

const ACCOUNT = "acc_pretend";
const CONNECTED = "acct_pretend";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const T0 = Date.parse("2026-12-01T15:00:00.000Z");

let sqlite: Database.Database;
const writer = inMemoryMoneyWriter(() => sqlite);

const env = {
  ENCRYPTION_KEY: "ab".repeat(32),
  BETTER_AUTH_URL: "https://foxhoundapp.test",
  PHYSICAL_ADDRESS: "1 Test Way, Austin TX 78701",
  MONEY_WRITER: writer.binding,
  EMAIL: {
    send: async (m: { from: string; to: string; subject: string; html: string }) => {
      if (harness.bouncing.has(m.to)) throw new Error("simulated provider outage");
      harness.sent.push(m);
      return { id: `msg_${harness.sent.length}` };
    },
  },
} as unknown as Env;

/** A simulated Stripe: invoices, their payment attempts and each customer's card, held in memory.
 *  A charge succeeds only while the customer's card works. An unknown call fails the test by name,
 *  so the journey shows exactly what Foxhound asks Stripe for. */
interface SimCustomer {
  email: string;
  cardWorks: boolean;
  card: { fingerprint: string; exp_month: number; exp_year: number };
}
const sim = {
  now: T0,
  customers: new Map<string, SimCustomer>(),
  invoices: new Map<string, Record<string, unknown>>(),
  attempts: new Map<string, Array<{ pi: string; created: number; ok: boolean }>>(),
  sessions: new Map<string, Record<string, unknown>>(),
  customerUpdates: [] as { id: string; params: Record<string, unknown> }[],
  subscriptionUpdates: [] as { id: string; params: Record<string, unknown> }[],
};

/** The customer finishes Stripe Checkout: a new working card is saved on the session. */
function completeCheckout(sessionId: string, customer: string) {
  const c = sim.customers.get(customer)!;
  c.cardWorks = true;
  c.card = { fingerprint: `fp_${customer}_new`, exp_month: 4, exp_year: 2031 };
  Object.assign(sim.sessions.get(sessionId)!, {
    status: "complete",
    setup_intent: { id: `seti_${sessionId}`, payment_method: `pm_${customer}_new` },
  });
}

function attemptCharge(invoiceId: string): boolean {
  const inv = sim.invoices.get(invoiceId)!;
  const ok = sim.customers.get(inv.customer as string)!.cardWorks;
  const list = sim.attempts.get(invoiceId) ?? [];
  list.push({
    pi: `pi_${invoiceId}_${list.length + 1}`,
    created: sim.now / 1000 + list.length,
    ok,
  });
  sim.attempts.set(invoiceId, list);
  if (ok) {
    Object.assign(inv, {
      status: "paid",
      amount_paid: inv.amount_due,
      status_transitions: { paid_at: Math.floor(sim.now / 1000) },
    });
  }
  return ok;
}

function chargeFor(invoiceId: string, attempt: { pi: string; ok: boolean }) {
  const inv = sim.invoices.get(invoiceId)!;
  const card = sim.customers.get(inv.customer as string)!.card;
  return {
    id: `ch_${attempt.pi}`,
    object: "charge",
    status: attempt.ok ? "succeeded" : "failed",
    amount: inv.amount_due,
    failure_code: attempt.ok ? null : "card_declined",
    outcome: {
      type: attempt.ok ? "authorized" : "issuer_declined",
      reason: attempt.ok ? null : "insufficient_funds",
      network_advice_code: null,
      network_decline_code: null,
    },
    payment_method_details: { card: { ...card, funding: "credit", brand: "visa", country: "US" } },
    balance_transaction: attempt.ok
      ? {
          id: `txn_${attempt.pi}`,
          fee: Math.round((inv.amount_due as number) * 0.029) + 30,
          net: (inv.amount_due as number) - Math.round((inv.amount_due as number) * 0.029) - 30,
          currency: "usd",
        }
      : null,
  };
}

function cardError(): Error {
  return Object.assign(new Error("Your card has insufficient funds."), {
    type: "StripeCardError",
    code: "card_declined",
    decline_code: "insufficient_funds",
    statusCode: 402,
  });
}

const LIST = Symbol("list");
const asList = (items: unknown[]) => ({ [LIST]: items });

function fakeStripe(): unknown {
  const handlers: Record<string, (...args: never[]) => unknown> = {
    "invoices.retrieve": (id: string) => {
      const inv = sim.invoices.get(id);
      if (!inv) throw new Error(`no invoice ${id}`);
      return inv;
    },
    "invoicePayments.list": (params: { invoice: string }) =>
      asList(
        (sim.attempts.get(params.invoice) ?? []).map((a) => ({
          created: a.created,
          payment: { payment_intent: a.pi },
        })),
      ),
    "paymentIntents.retrieve": (id: string) => {
      for (const [invoiceId, list] of sim.attempts) {
        const attempt = list.find((a) => a.pi === id);
        if (attempt) {
          return {
            id,
            status: attempt.ok ? "succeeded" : "requires_payment_method",
            last_payment_error: attempt.ok ? null : { decline_code: "insufficient_funds" },
            latest_charge: chargeFor(invoiceId, attempt),
          };
        }
      }
      throw new Error(`no payment intent ${id}`);
    },
    "checkout.sessions.create": (params: Record<string, unknown>) => {
      const id = `cs_${sim.sessions.size + 1}`;
      sim.sessions.set(id, { id, status: "open", ...params });
      return { id, url: `https://checkout.stripe.test/${id}` };
    },
    "checkout.sessions.retrieve": (id: string) => sim.sessions.get(id),
    "customers.update": (id: string, params: Record<string, unknown>) => {
      sim.customerUpdates.push({ id, params });
      return { id };
    },
    "subscriptions.update": (id: string, params: Record<string, unknown>) => {
      sim.subscriptionUpdates.push({ id, params });
      return { id };
    },
    "invoices.pay": (id: string) => {
      if (!attemptCharge(id)) throw cardError();
      return sim.invoices.get(id);
    },
  };
  const node = (path: string[]): unknown =>
    new Proxy(() => {}, {
      get: (_t, key) =>
        typeof key === "string" && key !== "then" ? node([...path, key]) : undefined,
      apply: (_t, _this, args) => {
        const name = path.join(".");
        harness.stripeCalls.push(name);
        const handler = handlers[name];
        if (!handler) return Promise.reject(new Error(`simulated Stripe has no ${name}`));
        let result: unknown;
        try {
          result = handler(...(args as never[]));
        } catch (err) {
          return Promise.reject(err);
        }
        if (result && typeof result === "object" && LIST in result) {
          const items = (result as { [LIST]: unknown[] })[LIST];
          return {
            async *[Symbol.asyncIterator]() {
              yield* items;
            },
          };
        }
        return Promise.resolve(structuredClone(result));
      },
    });
  return node([]);
}

function invoiceEvent(type: string, invoiceId: string) {
  return {
    id: `evt_${type}_${invoiceId}_${sim.now}`,
    object: "event",
    type,
    account: CONNECTED,
    livemode: true,
    created: Math.floor(sim.now / 1000),
    data: { object: structuredClone(sim.invoices.get(invoiceId)) },
  } as never;
}

/** A subscription renewal that declines: the customer, the invoice and its first failed attempt. */
function declinedRenewal(name: string, amount: number) {
  const customer = `cus_${name}`;
  sim.customers.set(customer, {
    email: `${name}@customer.test`,
    cardWorks: false,
    card: { fingerprint: `fp_${name}_old`, exp_month: 12, exp_year: 2027 },
  });
  const id = `in_${name}`;
  sim.invoices.set(id, {
    id,
    object: "invoice",
    customer,
    customer_email: `${name}@customer.test`,
    customer_name: null,
    amount_due: amount,
    amount_paid: 0,
    currency: "usd",
    status: "open",
    collection_method: "charge_automatically",
    next_payment_attempt: null,
    parent: { subscription_details: { subscription: `sub_${name}` } },
  });
  attemptCharge(id);
}

function rows(sql: string, ...params: unknown[]) {
  return sqlite.prepare(sql).all(...(params as never[])) as Record<string, unknown>[];
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  const created = createInMemoryDb();
  sqlite = created.sqlite;
  harness.db = created.db;
  harness.stripe = fakeStripe();
  sqlite
    .prepare(
      "INSERT INTO accounts (id, name, created_at, notification_email, live_sends_enabled) VALUES (?, 'Pretend Co', ?, 'owner@pretend.test', 1)",
    )
    .run(ACCOUNT, T0 - 30 * DAY);
  sqlite
    .prepare(
      "INSERT INTO stripe_connections (id, account_id, stripe_user_id, stripe_access_token, is_primary, connected_at, created_at) VALUES ('conn_p', ?, ?, ?, 1, ?, ?)",
    )
    .run(ACCOUNT, CONNECTED, await encryptToken(env, "sk_simulated"), T0 - 30 * DAY, T0 - 30 * DAY);
  declinedRenewal("ana", 4900);
  declinedRenewal("ben", 9900);
});

describe("a pretend merchant, end to end", () => {
  it("a declined card opens a recovery with a planned sequence", async () => {
    for (const id of ["in_ana", "in_ben"]) {
      expect(
        await processConnectedWebhook(
          env,
          invoiceEvent("invoice.payment_failed", id),
          new Date(T0),
        ),
      ).toEqual({ status: "applied" });
    }
    const payments = rows(
      "SELECT stripe_invoice_id, status, decline_category, amount_cents FROM failed_payments ORDER BY stripe_invoice_id",
    );
    expect(payments).toEqual([
      {
        stripe_invoice_id: "in_ana",
        status: "active",
        decline_category: "soft",
        amount_cents: 4900,
      },
      {
        stripe_invoice_id: "in_ben",
        status: "active",
        decline_category: "soft",
        amount_cents: 9900,
      },
    ]);
    const steps = rows("SELECT step_type, scheduled_at FROM recovery_steps ORDER BY scheduled_at");
    expect(steps.map((r) => r.step_type)).toEqual(
      [
        "retry_early",
        "email_day1",
        "retry_day2",
        "email_day3",
        "email_day7",
        "email_day14",
        "retry_day21",
        "email_day30",
      ].flatMap((t) => [t, t]),
    );
  });

  it("five hours on, the early retry declines again and each customer gets the first email", async () => {
    // One step per payment per run, the silent retry first.
    expect((await tickAt(T0 + 5 * HOUR + MINUTE)).message).toMatch(
      /2 retries \(0 recovered\), 0 emails/,
    );
    expect((await tickAt(T0 + 5 * HOUR + 6 * MINUTE)).message).toMatch(
      /0 retries.*2 emails, 0 skipped, 0 failed/,
    );
    expect(sim.attempts.get("in_ana")).toHaveLength(2);
    expect(sim.attempts.get("in_ben")).toHaveLength(2);
    // From the merchant's business name, which it never set as a sender name, not "Support".
    expect(new Set(harness.sent.map((m) => m.from))).toEqual(
      new Set(["Pretend Co <recovery@send.foxhoundapp.com>"]),
    );
    const firsts = harness.sent.map((m) => ({ to: m.to, subject: m.subject }));
    day1Emails.push(...harness.sent);
    expect(firsts.map((m) => m.to).sort()).toEqual(["ana@customer.test", "ben@customer.test"]);
  });

  it("by day 4 the day 2 retry has declined and the day 3 email has gone out", async () => {
    harness.sent.length = 0;
    for (let at = T0 + 6 * HOUR; at < T0 + 4 * DAY; at += HOUR) await tickAt(at);
    expect(sim.attempts.get("in_ana")).toHaveLength(3);
    expect(harness.sent.map((m) => [m.to, m.subject]).sort()).toEqual([
      ["ana@customer.test", "Still having trouble with your payment"],
      ["ben@customer.test", "Still having trouble with your payment"],
    ]);
  });

  it("Ana opens her day 1 email on day 4, updates her card, and is charged right away", async () => {
    sim.now = T0 + 4 * DAY;
    vi.setSystemTime(sim.now);
    const day1 = day1Emails.find((m) => m.to === "ana@customer.test")!;
    const clicked = await route(click.loader as never, buttonHref(day1.html), {
      token: buttonHref(day1.html).split("/e/c/")[1],
    });
    expect(clicked.status).toBe(302);
    const page = clicked.location!;
    expect(page).toMatch(new RegExp(`^${ORIGIN}/p/`));
    const token = page.split("/p/")[1];
    expect((await route(cardUpdate.loader as never, page, { token })).data).toMatchObject({
      state: "ready",
      amountCents: 4900,
    });
    const started = await route(cardUpdate.action as never, page, { token }, "POST");
    expect(started.location).toMatch(/^https:\/\/checkout\.stripe\.test\/cs_/);
    const sessionId = started.location!.split("/").pop()!;
    expect(sim.sessions.get(sessionId)).toMatchObject({ mode: "setup", customer: "cus_ana" });

    completeCheckout(sessionId, "cus_ana");
    const back = await route(cardUpdate.loader as never, `${page}?session_id=${sessionId}`, {
      token,
    });
    expect(back.location).toBe(`/p/${token}?done=1`);
    expect(sim.customerUpdates).toEqual([
      { id: "cus_ana", params: { invoice_settings: { default_payment_method: "pm_cus_ana_new" } } },
    ]);
    expect(sim.subscriptionUpdates.map((u) => u.id)).toEqual(["sub_ana"]);
    // The new card is charged now, not on the next scheduled retry 17 days later.
    expect(sim.invoices.get("in_ana")!.status).toBe("paid");
  });

  it("Stripe reports the payment, and the recovery is recorded and the merchant told", async () => {
    harness.sent.length = 0;
    expect(
      await processConnectedWebhook(
        env,
        invoiceEvent("invoice.payment_succeeded", "in_ana"),
        new Date(sim.now),
      ),
    ).toEqual({ status: "applied" });
    expect(rows("SELECT outcome, attribution_kind FROM outcomes")).toEqual([
      { outcome: "recovered_attributed", attribution_kind: "foxhound_retry" },
    ]);
    expect(rows("SELECT status FROM failed_payments WHERE stripe_invoice_id = 'in_ana'")).toEqual([
      { status: "recovered" },
    ]);
    expect(harness.sent.map((m) => [m.to, m.subject])).toEqual([
      ["owner@pretend.test", "Payment recovered: $49.00 from ana@customer.test"],
    ]);
  });

  it("Ben never pays: every retry declines, a failed email alerts support, and the sequence ends", async () => {
    harness.sent.length = 0;
    const results: string[] = [];
    for (let at = T0 + 4 * DAY; at <= T0 + 32 * DAY; at += HOUR) {
      // The mail provider refuses Ben's mail from day 7 to day 9, so the day 7 email fails for good.
      if (at === T0 + 7 * DAY) harness.bouncing.add("ben@customer.test");
      if (at === T0 + 9 * DAY) harness.bouncing.delete("ben@customer.test");
      const { message } = await tickAt(at);
      if (!(message ?? "").startsWith("0 due")) results.push(`${(at - T0) / DAY}: ${message}`);
    }
    expect(results).toEqual([
      "7: 1 due, 1 payments, 0 retries (0 recovered), 1 emails, 0 skipped, 0 failed, 0 exhausted",
      "7.041666666666667: 1 due, 1 payments, 0 retries (0 recovered), 1 emails, 0 skipped, 0 failed, 0 exhausted",
      "7.083333333333333: 1 due, 1 payments, 0 retries (0 recovered), 1 emails, 0 skipped, 0 failed, 0 exhausted",
      "7.25: 1 due, 1 payments, 0 retries (0 recovered), 1 emails, 0 skipped, 0 failed, 0 exhausted",
      "7.75: 1 due, 1 payments, 0 retries (0 recovered), 1 emails, 0 skipped, 0 failed, 0 exhausted",
      "14: 1 due, 1 payments, 0 retries (0 recovered), 1 emails, 0 skipped, 0 failed, 0 exhausted",
      "21: 1 due, 1 payments, 1 retries (0 recovered), 0 emails, 0 skipped, 0 failed, 0 exhausted",
      "30: 1 due, 1 payments, 0 retries (0 recovered), 1 emails, 0 skipped, 0 failed, 1 exhausted",
    ]);
    expect(harness.sent.map((m) => [m.to, m.subject])).toEqual([
      ["support@foxhoundapp.com", "Foxhound recovery email failed for good"],
      ["ben@customer.test", "Two weeks since your payment failed"],
      ["ben@customer.test", "Final notice on your account"],
      [
        "owner@pretend.test",
        "Recovery sequence ended: $99.00 from ben@customer.test was not recovered",
      ],
    ]);
    expect(
      rows(
        "SELECT step_type, result FROM recovery_steps rs JOIN failed_payments fp ON fp.id = rs.failed_payment_id WHERE fp.stripe_invoice_id = 'in_ben' ORDER BY scheduled_at",
      ),
    ).toEqual([
      { step_type: "retry_early", result: "retry_card_declined" },
      { step_type: "email_day1", result: "email_sent" },
      { step_type: "retry_day2", result: "retry_card_declined" },
      { step_type: "email_day3", result: "email_sent" },
      { step_type: "email_day7", result: "email_failed" },
      { step_type: "email_day14", result: "email_sent" },
      { step_type: "retry_day21", result: "retry_card_declined" },
      { step_type: "email_day30", result: "email_sent" },
    ]);
    expect(sim.attempts.get("in_ben")!.every((a) => !a.ok)).toBe(true);
    expect(rows("SELECT status FROM failed_payments WHERE stripe_invoice_id = 'in_ben'")).toEqual([
      { status: "failed_unrecovered" },
    ]);
  });

  it("the merchant's numbers show one recovered, one lost, and the fee owed on the recovery", async () => {
    const { stats } = await merchantSees("foxhound_get_recovery");
    expect(stats).toMatchObject({
      activeFailedCount: 0,
      totalFailedCount: 2,
      recoveredCount: 1,
      recoveryRatePct: 50,
      revenueRecovered: [{ currency: "usd", cents: 4900 }],
    });
    const { payments } = await merchantSees("foxhound_list_payments");
    expect(
      (payments as { stripeInvoiceId: string; status: string; customerEmail: string }[]).map(
        (p) => [p.stripeInvoiceId, p.status, p.customerEmail],
      ),
    ).toEqual([
      ["in_ana", "recovered", "a***@customer.test"],
      ["in_ben", "failed_unrecovered", "b***@customer.test"],
    ]);
    // 20% of the $49.00 Foxhound recovered; nothing for the $99.00 it did not.
    const { preview } = await merchantSees("foxhound_get_billing");
    expect(preview).toMatchObject({
      estimatedRecoveryFees: [{ currency: "usd", cents: 980 }],
    });
    const { payment_status_counts } = await merchantSees("foxhound_get_overview");
    expect(payment_status_counts).toEqual({
      all: 2,
      active: 0,
      recovered: 1,
      failedUnrecovered: 1,
      cancelled: 0,
    });
  });
});
