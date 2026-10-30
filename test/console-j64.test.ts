import { describe, expect, it } from "vitest";

import {
  accounts,
  auditRuns,
  customerContext,
  failedPayments,
  recoveredPayments,
  stripeConnections,
} from "~/db";
import { formatCurrencyTotalsShort, mrrMovementAlt } from "~/lib/dashboard/console";
import { getConsoleView } from "~/lib/dashboard/console.server";

import { createInMemoryDb } from "./helpers/inmemory-db";

// J64, row S2: /console is Recova's page
// (app/(app)/console/page.tsx at blob 3b8a736e, lib/console-data.tsx at
// 234791c4, lib/products.ts at 6be24574, each read whole) built from Capsomer
// 0.9.0's parts, charts by Enarratio, amber throughout. Recova is the spec for
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
      // The nightly scoring flags these for personal outreach (Recova's feed row).
      recommendedAction: "personal_outreach",
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


describe("console read model: money per currency (RULES.md 3.20)", () => {

  it("formats an attention row's MRR in that customer's own currency", async () => {
    const db = await seed({ atRisk: [{ mrr: 9_000, currency: "eur" }] });
    const view = await getConsoleView(db, ACCOUNT_ID, NOW, null);
    const row = view.attention.find((r) => r.key.startsWith("outreach-"));
    expect(row?.mrrCurrency).toBe("eur");
  });

  it("carries the audit run's own currency for its leak figure", async () => {
    const db = await seed({ audit: { currency: "gbp" } });
    const view = await getConsoleView(db, ACCOUNT_ID, NOW, null);
    expect(view.tiles.auditLeaking).toEqual([{ currency: "gbp", cents: 10_500 }]);
  });
});

describe("console read model: the Intelligence tile and rows", () => {
  // Recova counts every customer with a high-risk score (console/page.tsx,
  // intelligenceHighRiskResult has no limit). Foxhound had reused the three
  // rows it shows in the feed, so the tile stopped counting at three.
  it("counts every high-risk customer, not only the three outreach rows the feed shows", async () => {
    const db = await seed({
      atRisk: Array.from({ length: 5 }, () => ({ mrr: 1_000, currency: "usd" })),
    });
    const view = await getConsoleView(db, ACCOUNT_ID, NOW, null);
    expect(view.tiles.highRiskCustomerCount).toBe(5);
    expect(view.tiles.highRiskMrr).toEqual([{ currency: "usd", cents: 5_000 }]);
    expect(view.attention.filter((r) => r.key.startsWith("outreach-"))).toHaveLength(3);
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
    // The alt is built from the same whole units the bars draw, so it cannot
    // disagree with the chart or its data table: a $1.50 contraction draws as
    // Math.round(-1.5) = -1, so the alt must read -$1, not Intl's -$2.
    expect(
      mrrMovementAlt(
        { newMrrCents: 0, expansionMrrCents: 0, contractionMrrCents: 150, churnMrrCents: 0, reactivationMrrCents: 0 },
        "usd",
      ),
    ).toContain("Contract -$1,");
  });
});





describe("console read model: whether the monthly sync will write a snapshot", () => {
  it("says unconnected without a Stripe connection, eligible with one", async () => {
    const on = await seed({});
    expect((await getConsoleView(on, ACCOUNT_ID, NOW, null)).mrrSync).toBe("eligible");
  });

  it("says paused for a paused account and canceled for a canceled one", async () => {
    const db = await seed({});
    await db.update(accounts).set({ processingPaused: true });
    expect((await getConsoleView(db, ACCOUNT_ID, NOW, null)).mrrSync).toBe("paused");
    await db.update(accounts).set({ processingPaused: false, cancelledAt: new Date(NOW) });
    expect((await getConsoleView(db, ACCOUNT_ID, NOW, null)).mrrSync).toBe("cancelled");
  });

  it("says unconnected when the account has no Stripe connection", async () => {
    const db = await seed({});
    await db.delete(stripeConnections);
    expect((await getConsoleView(db, ACCOUNT_ID, NOW, null)).mrrSync).toBe("unconnected");
  });
});
