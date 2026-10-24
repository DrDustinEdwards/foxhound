import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { describe, expect, it, vi } from "vitest";

import {
  accountSubscriptions,
  accounts,
  customerContext,
  disputes,
  engagementEvents,
  failedPayments,
  recoveredPayments,
  recoverySteps,
} from "~/db/schema";
import CustomerPage from "~/routes/app/intelligence/customer";
import {
  tenureFromSince,
  type CustomerActivity,
} from "~/lib/intelligence/customer-detail";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { authContext } from "~/lib/auth/context";
import { getCustomerActivity } from "~/lib/intelligence/views.server";

import { createInMemoryDb } from "./helpers/inmemory-db";

// The route loader runs against an in-memory database in the sync-shaped test
// below; every other test passes its database explicitly.
const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

// J68, row S18: the Intelligence customer detail page toward Recova's real
// page, app/(app)/intelligence/customers/[id]/page.tsx at blob 8d31766d, with
// HealthSparkline (f4a163f5), RawDataToggle (640505cd), IntegrityLayerBanner
// (1614dfaf) and lib/intelligence/customer-context-ssr.ts (a499c285), all read
// whole.
//
// Recova's order in a 1080px column: the breadcrumb, the back link and the
// recovery payments link, the header card (name, email and Stripe id, plan
// pill, MRR, then Tenure, LTV, Last seen, Customer since), three signal cards,
// the health score card with its chart, the AI assessment when there is one,
// and the footer naming where else the customer's data lives.
//
// The signal cards read Foxhound's own tables for this customer, never the
// signal JSON (live sync writes a different shape from the demo's, and has no
// amounts, dates or 30-day windows at all).

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 15, 12, 0, 0); // 2026-10-15

describe("tenureFromSince: Recova's words", () => {
  const since = (days: number) => new Date(NOW - days * DAY);
  it("reads unknown, under a month, months, and years", () => {
    expect(tenureFromSince(null, NOW)).toBe("unknown");
    expect(tenureFromSince(since(10), NOW)).toBe("< 1 month");
    expect(tenureFromSince(since(30), NOW)).toBe("1 month");
    expect(tenureFromSince(since(150), NOW)).toBe("5 months");
    expect(tenureFromSince(since(360), NOW)).toBe("1 year");
    expect(tenureFromSince(since(720), NOW)).toBe("2 years");
    expect(tenureFromSince(since(450), NOW)).toBe("1y 3mo");
  });
});

const EMPTY: CustomerActivity = {
  recovery: {
    failedPaymentCount: 0,
    recoveredCount: 0,
    recoveredAmounts: [],
    lastFailedAt: null,
    lastRecoveredAt: null,
    activeRecovery: false,
  },
  disputes: {
    count: 0,
    openCount: 0,
    wonCount: 0,
    lostCount: 0,
    totalDisputed: [],
    lastDisputeAt: null,
    lastOutcome: null,
  },
  engagement: { everEngaged: false, opens30d: 0, clicks30d: 0, lastOpenAt: null },
  lastActivityAt: null,
};

const BUSY: CustomerActivity = {
  recovery: {
    failedPaymentCount: 3,
    recoveredCount: 2,
    recoveredAmounts: [
      { currency: "usd", cents: 9_800 },
      { currency: "eur", cents: 1_500 },
    ],
    lastFailedAt: new Date(Date.UTC(2026, 9, 1)),
    lastRecoveredAt: new Date(Date.UTC(2026, 8, 20)),
    activeRecovery: true,
  },
  disputes: {
    count: 2,
    openCount: 1,
    wonCount: 0,
    lostCount: 1,
    totalDisputed: [{ currency: "usd", cents: 12_000 }],
    lastDisputeAt: new Date(Date.UTC(2026, 9, 3)),
    lastOutcome: "resolved_lost",
  },
  engagement: { everEngaged: true, opens30d: 4, clicks30d: 1, lastOpenAt: new Date(Date.UTC(2026, 9, 10)) },
  lastActivityAt: new Date(NOW - 2 * DAY),
};

describe("getCustomerActivity: one customer's rows, this account only", () => {
  async function seeded() {
    const { db } = createInMemoryDb();
    await db.insert(accounts).values([
      { id: "acct_a", name: "Alpha" },
      { id: "acct_b", name: "Beta" },
    ]);
    let n = 0;
    const fp = async (accountId: string, customer: string, status: string, daysAgo: number, deleted = false) => {
      n += 1;
      const id = `fp_${n}`;
      await db.insert(failedPayments).values({
        id,
        accountId,
        stripeEventId: `evt_${n}`,
        stripeInvoiceId: `in_${n}`,
        stripeCustomerId: customer,
        customerEmail: "customer@example.com",
        amountCents: 5_000,
        currency: "usd",
        declineCategory: "soft",
        status,
        detectedAt: new Date(NOW - daysAgo * DAY),
        deletedAt: deleted ? new Date(NOW) : null,
      });
      return id;
    };
    const rp = async (accountId: string, failedPaymentId: string, cents: number, currency: string, daysAgo: number) => {
      await db.insert(recoveredPayments).values({
        id: `rp_${failedPaymentId}`,
        accountId,
        failedPaymentId,
        recoveredAt: new Date(NOW - daysAgo * DAY),
        amountCents: cents,
        currency,
        recoveryMethod: "email",
      });
    };
    const event = async (accountId: string, failedPaymentId: string, eventType: string, daysAgo: number) => {
      n += 1;
      const stepId = `step_${n}`;
      await db.insert(recoverySteps).values({
        id: stepId,
        accountId,
        failedPaymentId,
        stepType: "email",
        scheduledAt: new Date(NOW - daysAgo * DAY),
      });
      await db.insert(engagementEvents).values({
        id: `ee_${n}`,
        accountId,
        recoveryStepId: stepId,
        eventType,
        idempotencyKey: `idem_${n}`,
        occurredAt: new Date(NOW - daysAgo * DAY),
        createdAt: new Date(NOW - daysAgo * DAY),
      });
    };
    const dispute = async (accountId: string, customer: string, state: string, cents: number, daysAgo: number) => {
      n += 1;
      await db.insert(disputes).values({
        id: `dp_${n}`,
        accountId,
        stripeDisputeId: `dp_stripe_${n}`,
        stripeChargeId: `ch_${n}`,
        stripeCustomerId: customer,
        amountCents: cents,
        currency: "usd",
        reason: "fraudulent",
        status: "needs_response",
        state,
        createdAt: new Date(NOW - daysAgo * DAY),
        resolvedAt: state.startsWith("resolved") ? new Date(NOW - (daysAgo - 1) * DAY) : null,
      });
    };

    // Alpha's customer: three live failures (one recovered in USD, one in EUR,
    // one active), one deleted failure, two disputes, engagement inside and
    // outside the 30-day window.
    const usd = await fp("acct_a", "cus_x", "recovered", 40);
    const eur = await fp("acct_a", "cus_x", "recovered", 20);
    const active = await fp("acct_a", "cus_x", "active", 2);
    const deleted = await fp("acct_a", "cus_x", "recovered", 1, true);
    await rp("acct_a", usd, 4_900, "usd", 35);
    await rp("acct_a", eur, 1_500, "eur", 18);
    await rp("acct_a", deleted, 99_900, "usd", 1);
    await event("acct_a", usd, "open", 45);
    await event("acct_a", eur, "open", 10);
    await event("acct_a", eur, "click", 9);
    await event("acct_a", active, "open", 1);
    await dispute("acct_a", "cus_x", "resolved_won", 3_000, 60);
    await dispute("acct_a", "cus_x", "submitted", 7_000, 5);

    // The same Stripe customer id on another account, larger and newer, so a
    // leak moves every number.
    const foreign = await fp("acct_b", "cus_x", "recovered", 0);
    await rp("acct_b", foreign, 77_700, "usd", 0);
    await event("acct_b", foreign, "open", 0);
    await dispute("acct_b", "cus_x", "resolved_lost", 50_000, 0);
    // Another customer on Alpha.
    const other = await fp("acct_a", "cus_y", "active", 0);
    await event("acct_a", other, "click", 0);
    return db;
  }

  it("counts, totals and dates this customer's own rows", async () => {
    const db = await seeded();
    const a = await getCustomerActivity(db, "acct_a", "cus_x", NOW);
    expect(a.recovery).toEqual({
      failedPaymentCount: 3,
      recoveredCount: 2,
      recoveredAmounts: [
        { currency: "eur", cents: 1_500 },
        { currency: "usd", cents: 4_900 },
      ],
      lastFailedAt: new Date(NOW - 2 * DAY),
      lastRecoveredAt: new Date(NOW - 18 * DAY),
      activeRecovery: true,
    });
    expect(a.disputes).toEqual({
      count: 2,
      openCount: 1,
      wonCount: 1,
      lostCount: 0,
      totalDisputed: [{ currency: "usd", cents: 10_000 }],
      lastDisputeAt: new Date(NOW - 5 * DAY),
      lastOutcome: "resolved_won",
    });
    expect(a.engagement).toEqual({
      everEngaged: true,
      opens30d: 2,
      clicks30d: 1,
      lastOpenAt: new Date(NOW - 1 * DAY),
    });
    // The latest of every dated row above: the open on the active payment, a
    // day ago. The deleted payment (also a day ago) is not counted.
    expect(a.lastActivityAt).toEqual(new Date(NOW - 1 * DAY));
  });

  it("is all empty for a customer with nothing on record", async () => {
    const db = await seeded();
    expect(await getCustomerActivity(db, "acct_a", "cus_nobody", NOW)).toEqual(EMPTY);
  });
});

// ---- The page ----

const Page = CustomerPage as unknown as (props: { loaderData: unknown }) => ReactElement;

// Newest first, as getCustomerHealthDetail returns it; the page reverses it.
const history = [
  { recordedAt: new Date(NOW - 1 * DAY), healthScore: 41 },
  { recordedAt: new Date(NOW - 10 * DAY), healthScore: 52 },
  { recordedAt: new Date(NOW - 20 * DAY), healthScore: 64 },
];

function loaderData(over: Record<string, unknown> = {}) {
  return {
    entitled: true,
    nowMs: NOW,
    accountName: "Acme",
    customer: {
      stripeCustomerId: "cus_sample_1",
      customerName: "Sample Bakery",
      customerEmail: "owner@example.com",
      currentPlanName: "Growth Monthly",
      currentPlanTier: null,
      mrrContributionCents: 4_900,
      currency: "usd",
      ltvCents: null,
      customerSince: new Date(NOW - 450 * DAY),
      healthScore: 41,
      healthFactors: [{ signal: "refunds_disputes", deltaPoints: -16, detail: "1 refund(s) and 1 dispute(s) on record" }],
      aiAssessment: "Two failed payments in a month and a lost dispute.",
      aiAssessmentGeneratedAt: new Date(Date.UTC(2026, 9, 14)),
      history,
      predictions: [],
    },
    activity: BUSY,
    ...over,
  };
}

function render(data: unknown = loaderData()): string {
  const Stub = createRoutesStub([
    { path: "/intelligence/customers/:id", Component: () => createElement(Page, { loaderData: data }) },
  ]);
  return renderToStaticMarkup(createElement(Stub, { initialEntries: ["/intelligence/customers/cus_sample_1"] }));
}

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replaceAll("&#x27;", "'")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replace(/\s+/g, " ")
    .replace(/ ([.,])/g, "$1")
    .trim();
}



// J68 review, must-fix 1: the nightly sync writes customer_context.last_seen_at
// as the sync's own time for every customer (sync.server.ts
// buildCustomerContextUpsert, `lastSeenAt: input.now`), so the column is not
// when the customer was last seen. These rows are shaped the way the sync
// writes them: every last_seen_at is the sync time, no tier, no LTV, and zero
// MRR for a customer with no active subscription.
describe("J68 review: 'Last seen' on rows shaped the way the sync writes them", () => {
  const SYNC = new Date(NOW - 3 * 3_600_000); // tonight's run, 03:00 earlier today

  async function syncShaped() {
    const { db } = createInMemoryDb();
    await db.insert(accounts).values({ id: "acct_live", name: "Live Co" });
    await db.insert(accountSubscriptions).values({
      id: "sub_intel",
      accountId: "acct_live",
      product: "intelligence",
      status: "active",
      createdAt: new Date(NOW - 90 * DAY),
    });
    for (const [id, mrr] of [
      ["cus_busy", 0],
      ["cus_quiet", 2_900],
    ] as const) {
      await db.insert(customerContext).values({
        id: `ctx_${id}`,
        accountId: "acct_live",
        stripeCustomerId: id,
        customerEmail: `${id}@example.com`,
        customerName: id === "cus_busy" ? "Busy Ltd" : "Quiet Ltd",
        customerSince: new Date(NOW - 200 * DAY),
        lastSeenAt: SYNC,
        mrrContributionCents: mrr,
        activeSubscriptionsCount: mrr > 0 ? 1 : 0,
        currentPlanName: mrr > 0 ? "Basic" : null,
        recoverySignals: { failedPaymentCount: 1, recoveredCount: 0, avgDaysToRecover: null },
        disputeSignals: { disputeCount: 0, wonCount: 0, lostCount: 0 },
        engagementSignals: { openCount: 0, clickCount: 0, lastEngagedAtMs: null },
        createdAt: SYNC,
        updatedAt: SYNC,
      });
    }
    // Busy Ltd's one real event: a payment that failed nine days ago.
    await db.insert(failedPayments).values({
      id: "fp_busy",
      accountId: "acct_live",
      stripeEventId: "evt_busy",
      stripeInvoiceId: "in_busy",
      stripeCustomerId: "cus_busy",
      customerEmail: "cus_busy@example.com",
      amountCents: 2_900,
      currency: "usd",
      declineCategory: "soft",
      status: "failed_unrecovered",
      detectedAt: new Date(NOW - 9 * DAY),
    });
    return db;
  }

  function contextFor() {
    return {
      get(key: unknown) {
        if (key === cloudflareContext) return { env: {}, ctx: {}, nonce: "n" };
        if (key === authContext) return { membership: { accountId: "acct_live", accountName: "Live Co" }, isDemo: false };
        throw new Error("unexpected context key");
      },
    } as never;
  }

  async function renderThroughLoader(id: string): Promise<string> {
    harness.db = await syncShaped();
    const { loader } = await import("~/routes/app/intelligence/customer");
    const data = await loader({ context: contextFor(), params: { id }, request: new Request("https://x.test/") } as never);
    // The loader's data goes through the page exactly as React Router hands it over.
    return render(JSON.parse(JSON.stringify(data), (_k, v) =>
      typeof v === "string" && /^\d{4}-\d\d-\d\dT/.test(v) ? new Date(v) : v,
    ));
  }

  it("shows the customer's latest event, never the sync time", async () => {
    const t = text(await renderThroughLoader("cus_busy"));
    expect(t).toContain("Last seen Oct 6, 2026");
    expect(t).not.toContain("Last seen Oct 15, 2026");
  });

  it("says 'Not tracked' when Foxhound has no event for the customer", async () => {
    const t = text(await renderThroughLoader("cus_quiet"));
    expect(t).toContain("Last seen Not tracked");
    expect(t).not.toContain("Oct 15, 2026");
  });
});
