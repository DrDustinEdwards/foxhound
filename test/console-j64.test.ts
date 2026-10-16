import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import {
  accountSubscriptions,
  accounts,
  auditRuns,
  customerContext,
  failedPayments,
  recoveredPayments,
  stripeConnections,
} from "~/db";
import { INTELLIGENCE_PRODUCT, SUBSCRIPTION_STATUS_ACTIVE } from "~/lib/constants";
import { formatCurrencyTotalsShort, mrrMovementAlt } from "~/lib/dashboard/console";
import { getConsoleView, type ConsoleView } from "~/lib/dashboard/console.server";
import type { MrrAnalytics, RecoveryStats } from "~/lib/dashboard/stats.server";
import Console from "~/routes/app/dashboard";

import { createInMemoryDb } from "./helpers/inmemory-db";

// J64 (job_88cdaa1852f1), row S2: /console is Recova's page
// (app/(app)/console/page.tsx at blob 3b8a736e, lib/console-data.tsx at
// 234791c4, lib/products.ts at 6be24574, each read whole) built from Capsomer
// 0.9.0's parts, charts by Enarratio, teal throughout. Recova is the spec for
// the sections, labels and their order; the numbers are Foxhound's engine.
// Every assertion here was seen failing before the change (red output in the
// pull request).

const NOW = Date.parse("2026-07-25T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const ACCOUNT_ID = "acct_j64";

async function seed(opts: {
  recovered?: { cents: number; currency: string }[];
  active?: { cents: number; currency: string }[];
  atRisk?: { mrr: number; currency: string }[];
  entitled?: boolean;
  audit?: { currency: string } | null;
}) {
  const { db } = createInMemoryDb();
  const now = new Date(NOW);
  await db.insert(accounts).values({ id: ACCOUNT_ID, name: "J64 Co", createdAt: now });
  await db.insert(stripeConnections).values({
    id: "conn_1",
    accountId: ACCOUNT_ID,
    stripeUserId: "acct_x",
    stripeAccessToken: "tok_test",
    createdAt: now,
    isPrimary: true,
  });
  if (opts.entitled) {
    await db.insert(accountSubscriptions).values({
      id: "sub_1",
      accountId: ACCOUNT_ID,
      product: INTELLIGENCE_PRODUCT,
      status: SUBSCRIPTION_STATUS_ACTIVE,
      createdAt: now,
    });
  }
  let n = 0;
  const fp = async (amountCents: number, currency: string, status: string) => {
    n++;
    await db.insert(failedPayments).values({
      id: `fp_${n}`,
      accountId: ACCOUNT_ID,
      stripeEventId: `evt_${n}`,
      stripeInvoiceId: `in_${n}`,
      stripeCustomerId: `cus_${n}`,
      customerEmail: `c${n}@example.com`,
      amountCents,
      currency,
      declineCategory: "soft",
      status,
      detectedAt: new Date(NOW - 5 * DAY),
      isRenewalNoise: false,
    });
    return `fp_${n}`;
  };
  for (const r of opts.active ?? []) await fp(r.cents, r.currency, "active");
  let k = 0;
  for (const r of opts.recovered ?? []) {
    k++;
    await db.insert(recoveredPayments).values({
      id: `rp_${k}`,
      accountId: ACCOUNT_ID,
      failedPaymentId: await fp(r.cents, r.currency, "recovered"),
      recoveredAt: new Date(Date.UTC(2026, 6, 10)),
      amountCents: r.cents,
      currency: r.currency,
      recoveryMethod: "retry",
      attributionKind: "foxhound_retry",
    });
  }
  let c = 0;
  for (const r of opts.atRisk ?? []) {
    c++;
    await db.insert(customerContext).values({
      id: `cc_${c}`,
      accountId: ACCOUNT_ID,
      stripeCustomerId: `cus_ctx_${c}`,
      customerName: `AtRisk ${c}`,
      healthScore: 10,
      mrrContributionCents: r.mrr,
      currency: r.currency,
      createdAt: now,
      updatedAt: now,
    });
  }
  if (opts.audit) {
    await db.insert(auditRuns).values({
      id: "audit_1",
      accountId: ACCOUNT_ID,
      runAt: new Date(NOW - DAY),
      lookbackDays: 90,
      failedInvoicesCents: 10_000,
      openDisputesCents: 500,
      currency: opts.audit.currency,
      createdAt: now,
    });
  }
  return db;
}

const sorted = (rows: { currency: string; cents: number }[]) =>
  [...rows].sort((a, b) => a.currency.localeCompare(b.currency));

describe("console read model: money per currency (RULES.md 3.20)", () => {
  it("totals this month's recoveries per currency, never adding EUR to USD", async () => {
    const db = await seed({
      recovered: [
        { cents: 1_000, currency: "usd" },
        { cents: 2_000, currency: "eur" },
        { cents: 500, currency: "usd" },
      ],
    });
    const view = await getConsoleView(db, ACCOUNT_ID, NOW, null);
    expect(sorted(view.hero.protectedThisMonth)).toEqual([
      { currency: "eur", cents: 2_000 },
      { currency: "usd", cents: 1_500 },
    ]);
    expect(sorted(view.tiles.recoveredThisMonth)).toEqual(sorted(view.hero.protectedThisMonth));
  });

  it("keeps every currency of the at-risk total, not only the first", async () => {
    const db = await seed({
      active: [
        { cents: 1_200, currency: "usd" },
        { cents: 3_000, currency: "gbp" },
      ],
    });
    const view = await getConsoleView(db, ACCOUNT_ID, NOW, null);
    expect(sorted(view.hero.atRisk)).toEqual([
      { currency: "gbp", cents: 3_000 },
      { currency: "usd", cents: 1_200 },
    ]);
  });

  it("totals high-risk MRR per currency", async () => {
    const db = await seed({
      entitled: true,
      atRisk: [
        { mrr: 4_000, currency: "usd" },
        { mrr: 9_000, currency: "eur" },
      ],
    });
    const view = await getConsoleView(db, ACCOUNT_ID, NOW, null);
    expect(sorted(view.tiles.highRiskMrr)).toEqual([
      { currency: "eur", cents: 9_000 },
      { currency: "usd", cents: 4_000 },
    ]);
  });

  it("formats an attention row's MRR in that customer's own currency", async () => {
    const db = await seed({ entitled: true, atRisk: [{ mrr: 9_000, currency: "eur" }] });
    const view = await getConsoleView(db, ACCOUNT_ID, NOW, null);
    const row = view.attention.find((r) => r.key.startsWith("at-risk-"));
    expect(row?.mrrCurrency).toBe("eur");
  });

  it("carries the audit run's own currency for its leak figure", async () => {
    const db = await seed({ audit: { currency: "gbp" } });
    const view = await getConsoleView(db, ACCOUNT_ID, NOW, null);
    expect(view.tiles.auditCurrency).toBe("gbp");
  });
});

describe("console read model: the Intelligence tile and rows", () => {
  // Recova counts every customer with a high-risk score (console/page.tsx,
  // intelligenceHighRiskResult has no limit). Foxhound had reused the three
  // rows it shows in the feed, so the tile stopped counting at three.
  it("counts every high-risk customer, not only the three the feed shows", async () => {
    const db = await seed({
      entitled: true,
      atRisk: Array.from({ length: 5 }, () => ({ mrr: 1_000, currency: "usd" })),
    });
    const view = await getConsoleView(db, ACCOUNT_ID, NOW, null);
    expect(view.tiles.highRiskCustomerCount).toBe(5);
    expect(view.tiles.highRiskMrr).toEqual([{ currency: "usd", cents: 5_000 }]);
    expect(view.attention.filter((r) => r.key.startsWith("at-risk-"))).toHaveLength(3);
  });

  // Recova reads these only when Intelligence is active, and every row links
  // to /intelligence/customers/:id, a page only an entitled account can open.
  it("shows no Intelligence rows to an account without Intelligence", async () => {
    const db = await seed({ entitled: false, atRisk: [{ mrr: 9_000, currency: "usd" }] });
    const view = await getConsoleView(db, ACCOUNT_ID, NOW, null);
    expect(view.attention.filter((r) => r.key.startsWith("at-risk-"))).toEqual([]);
    expect(view.tiles.highRiskCustomerCount).toBe(0);
  });
});

describe("console formatting helpers", () => {
  it("prints each currency's total in Recova's short format, joined", () => {
    expect(formatCurrencyTotalsShort([])).toBe("$0");
    expect(
      formatCurrencyTotalsShort([
        { currency: "usd", cents: 125_000 },
        { currency: "eur", cents: 2_000 },
      ]),
    ).toBe("$1,250 · €20");
  });

  it("gives the movement chart a text equivalent with its numbers", () => {
    expect(
      mrrMovementAlt(
        {
          newMrrCents: 10_000,
          expansionMrrCents: 2_000,
          contractionMrrCents: 500,
          churnMrrCents: 1_500,
          reactivationMrrCents: 0,
        },
        "usd",
      ),
    ).toBe("MRR movements in the latest month: New $100, Expand $20, Contract -$5, Churn -$15, Reactivate $0.");
  });
});

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

type LoaderData = {
  stats: RecoveryStats;
  mrr: MrrAnalytics;
  consoleView: ConsoleView;
  nowMs: number;
};

function makeData(over: { view?: Partial<ConsoleView>; tiles?: Partial<ConsoleView["tiles"]>; hero?: Partial<ConsoleView["hero"]> } = {}): LoaderData {
  const base: ConsoleView = {
    hero: {
      protectedThisMonth: [{ currency: "usd", cents: 1_000 }, { currency: "eur", cents: 2_000 }],
      recoveredAllTimeCount: 4,
      atRisk: [{ currency: "usd", cents: 5_500 }],
      activeSequenceCount: 3,
      openDisputeCount: 1,
      recoveryRatePct: 42,
      ...over.hero,
    },
    tiles: {
      stripeConnected: true,
      intelligenceEntitled: true,
      recoveredThisMonth: [{ currency: "usd", cents: 1_000 }],
      recoveryRatePct: 42,
      openDisputeCount: 1,
      disputesDueSoonCount: 0,
      highRiskMrr: [{ currency: "usd", cents: 4_000 }],
      highRiskCustomerCount: 2,
      lastAuditAt: new Date(NOW - DAY),
      auditLeakingCents: 10_500,
      auditCurrency: "usd",
      ...over.tiles,
    },
    attention: [
      {
        key: "dispute-d1",
        tone: "urgent",
        subject: "Disputer 1",
        detail: "dispute due",
        emphasis: "in 5h",
        mrrCents: null,
        mrrCurrency: null,
        href: "/disputes/d1",
        ariaLabel: "Open dispute for Disputer 1",
        product: "Disputes",
      },
    ],
    ...over.view,
  };
  return {
    stats: {
      activeFailedCount: 3,
      totalFailedCount: 10,
      recoveredCount: 4,
      recoveryRatePct: 42,
      revenueRecovered: [{ currency: "usd", cents: 50_000 }, { currency: "eur", cents: 7_000 }],
      billableRevenue: [{ currency: "usd", cents: 40_000 }],
      feeOwed: [{ currency: "usd", cents: 8_000 }],
    },
    mrr: { latest: null, trend: [] },
    consoleView: base,
    nowMs: NOW,
  };
}

function render(data: LoaderData): string {
  try {
    const Page = Console as unknown as (p: { loaderData: LoaderData }) => React.ReactElement;
    return renderToStaticMarkup(createElement(MemoryRouter, null, createElement(Page, { loaderData: data })));
  } catch (err) {
    return `render failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("the console page, toward Recova", () => {
  it("is headed Console, as Recova's page is", () => {
    const html = render(makeData());
    expect(html).toMatch(/<h1[^>]*>\s*Console\s*<\/h1>/);
  });

  it("has no visible Needs attention heading, which Recova's page never had", () => {
    const html = render(makeData());
    expect(html).not.toMatch(/<h2[^>]*>[^<]*Needs attention/);
    expect(html).toContain('aria-label="Needs attention"');
  });

  it("says N high-risk on the Intelligence tile, Recova's words", () => {
    expect(text(render(makeData()))).toContain("2 high-risk");
  });

  it("adds nothing under Disputes when none are due, as Recova adds nothing", () => {
    const t = text(render(makeData()));
    // Proves the tile rendered before the absence counts (RULES.md 6.2).
    expect(t).toContain("1 open");
    expect(t).not.toContain("Nothing due soon");
  });

  it("links the Audit tile to the run history once a run exists, else to connect", () => {
    expect(render(makeData())).toContain('href="/audit/history"');
    const none = render(makeData({ tiles: { lastAuditAt: null, auditLeakingCents: 0 } }));
    expect(none).toContain('href="/audit/connect"');
    expect(text(none)).toContain("Run free audit");
  });

  it("shows every currency of the protected total", () => {
    const t = text(render(makeData()));
    expect(t).toContain("$10 · €20");
  });

  it("shows every currency of revenue recovered", () => {
    const t = text(render(makeData()));
    expect(t).toContain("$500.00 · €70.00");
  });

  it("carries no amber anywhere on the page (Q11)", () => {
    const html = render(makeData({ tiles: { stripeConnected: false, intelligenceEntitled: false } }));
    // Proves the inactive tiles rendered before the absence counts (RULES.md 6.2).
    expect(text(html)).toContain("Connect Stripe");
    expect(html).not.toMatch(/amber|caution|warning-text/);
  });

  it("is built from Capsomer's parts (Q10): page head, panels, stat tiles and rows", () => {
    const html = render(makeData());
    expect(html).toContain("cap-page-head");
    expect(html).toContain("cap-panel");
    expect(html).toContain("cap-tile");
    expect(html).toContain("cap-row");
  });

  it("names the monthly sync when there is no MRR snapshot yet, true of the engine", () => {
    const t = text(render(makeData()));
    expect(t).toContain("The first snapshot runs on");
    expect(t).not.toContain("full billing cycle");
  });
});

describe("console source", () => {
  const source = readFileSync("app/routes/app/dashboard.tsx", "utf8");
  const panels = readFileSync("app/components/console-panels.tsx", "utf8");

  it("draws its charts with Enarratio, not the hand-built SVG module (Q1)", () => {
    expect(source).not.toContain("~/components/charts");
    expect(source).toContain("EnarratioFigure");
  });

  it("prints the fee from the pricing constant, never a typed 20%", () => {
    expect(source).not.toMatch(/`20% of/);
  });

  it("keeps the type scale to the five sizes and no arbitrary text values (RULES.md 5.2)", () => {
    expect(source + panels).not.toMatch(/text-\[/);
    expect(source + panels).not.toMatch(/\btext-(xs|sm|base|lg|xl|2xl)\b/);
  });
});
