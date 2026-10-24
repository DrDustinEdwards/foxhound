import { describe, expect, it } from "vitest";

import {
  accountSubscriptions,
  accounts,
  auditRuns,
  customerContext,
  disputes,
  expiringCardAlerts,
  failedPayments,
  recoveredPayments,
  recoverySteps,
  stripeConnections,
} from "~/db";
import { INTELLIGENCE_PRODUCT, SUBSCRIPTION_STATUS_ACTIVE } from "~/lib/constants";
import {
  atRiskSubtext,
  deadlinePhrase,
  expiryPhrase,
  isCardInAttentionWindow,
  isSequenceExhausted,
  lastRunPhrase,
  protectedSubtext,
} from "~/lib/dashboard/console";
import { getConsoleView } from "~/lib/dashboard/console.server";

import { createInMemoryDb } from "./helpers/inmemory-db";

const NOW = Date.parse("2026-07-25T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const ACCOUNT_ID = "acct_console";

describe("deadlinePhrase", () => {
  // A passed deadline stays surfaced: the merchant may still be able to submit,
  // and hiding it would be the worse failure.
  it("reads overdue once the deadline has passed", () => {
    expect(deadlinePhrase(new Date(NOW - HOUR), NOW)).toBe("overdue");
  });

  it("escalates through the last hour, the same day, then tomorrow", () => {
    expect(deadlinePhrase(new Date(NOW + 30 * 60 * 1000), NOW)).toBe("within the hour");
    expect(deadlinePhrase(new Date(NOW + 5 * HOUR), NOW)).toBe("in 5h");
    expect(deadlinePhrase(new Date(NOW + 30 * HOUR), NOW)).toBe("tomorrow");
  });

  it("treats exactly one hour out as an hour, not as within the hour", () => {
    expect(deadlinePhrase(new Date(NOW + HOUR), NOW)).toBe("in 1h");
  });
});

describe("expiryPhrase and the card window", () => {
  it("phrases today, tomorrow, and further out", () => {
    expect(expiryPhrase(new Date(NOW), NOW)).toBe("expires today");
    expect(expiryPhrase(new Date(NOW + DAY), NOW)).toBe("expires tomorrow");
    expect(expiryPhrase(new Date(NOW + 5 * DAY), NOW)).toBe("expires in 5 days");
  });

  it("includes cards inside the window and excludes ones long past", () => {
    expect(isCardInAttentionWindow(new Date(NOW + 3 * DAY), NOW)).toBe(true);
    expect(isCardInAttentionWindow(new Date(NOW + 7 * DAY), NOW)).toBe(true);
    expect(isCardInAttentionWindow(new Date(NOW + 30 * DAY), NOW)).toBe(false);
    // Expired weeks ago is history, not an action.
    expect(isCardInAttentionWindow(new Date(NOW - 20 * DAY), NOW)).toBe(false);
  });
});

describe("lastRunPhrase", () => {
  it("names today, yesterday, and older runs", () => {
    expect(lastRunPhrase(new Date(NOW), NOW)).toBe("Last run today");
    expect(lastRunPhrase(new Date(NOW - DAY), NOW)).toBe("Last run yesterday");
    expect(lastRunPhrase(new Date(NOW - 9 * DAY), NOW)).toBe("Last run 9 days ago");
  });
});

describe("isSequenceExhausted", () => {
  const step = (o: Partial<{ scheduledAt: Date; executedAt: Date | null; result: string | null }>) => ({
    scheduledAt: new Date(NOW),
    executedAt: null,
    result: null,
    ...o,
  });

  // A step scheduled in the past that never executed will not fire on its own, so
  // the sequence is done in practice even though the step is unexecuted.
  it("is exhausted when the only unexecuted step is already overdue", () => {
    expect(isSequenceExhausted([step({ scheduledAt: new Date(NOW - DAY) })], NOW)).toBe(true);
  });
});

describe("hero subtexts", () => {
  it("pluralizes and joins both parts", () => {
    expect(atRiskSubtext(3, 2)).toBe("3 active sequences · 2 open disputes");
    expect(atRiskSubtext(1, 1)).toBe("1 active sequence · 1 open dispute");
  });

  it("says All clear when there is nothing in play", () => {
    expect(atRiskSubtext(0, 0)).toBe("All clear");
  });

  it("distinguishes no recoveries from a count", () => {
    expect(protectedSubtext(0)).toBe("No recoveries yet");
    expect(protectedSubtext(1)).toBe("1 payment recovered all time");
    expect(protectedSubtext(9)).toBe("9 payments recovered all time");
  });
});

// ---------------------------------------------------------------------------
// Read model, against the real schema
// ---------------------------------------------------------------------------

async function seedConsole(opts: {
  activeAmounts?: number[];
  recoveredThisMonth?: number[];
  recoveredEarlier?: number[];
  disputeDeadlines?: (number | null)[];
  resolvedDisputes?: number;
  atRisk?: { score: number; mrr: number }[];
  cardMonthsOut?: number[];
  audit?: { daysAgo: number; failedCents: number; disputeCents: number } | null;
  connected?: boolean;
  entitled?: boolean;
} = {}) {
  const { db } = createInMemoryDb();
  const now = new Date(NOW);
  await db.insert(accounts).values({ id: ACCOUNT_ID, name: "Console Co", createdAt: now });

  if (opts.connected !== false) {
    await db.insert(stripeConnections).values({
      id: "conn_1",
      accountId: ACCOUNT_ID,
      stripeUserId: "acct_x",
      stripeAccessToken: "tok_test",
      createdAt: now,
      isPrimary: true,
    });
  }
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
  const fp = async (amountCents: number, status: string) => {
    n++;
    const id = `fp_${n}`;
    await db.insert(failedPayments).values({
      id,
      accountId: ACCOUNT_ID,
      stripeEventId: `evt_${n}`,
      stripeInvoiceId: `in_${n}`,
      stripeCustomerId: `cus_${n}`,
      customerEmail: `c${n}@example.com`,
      customerName: `Customer ${n}`,
      amountCents,
      currency: "usd",
      declineCategory: "soft",
      status,
      detectedAt: new Date(NOW - 5 * DAY),
      isRenewalNoise: false,
    });
    return id;
  };

  for (const amount of opts.activeAmounts ?? []) {
    const id = await fp(amount, "active");
    // One executed step and one still in the future, so it is NOT exhausted.
    await db.insert(recoverySteps).values([
      {
        id: `${id}_s1`,
        accountId: ACCOUNT_ID,
        failedPaymentId: id,
        stepType: "email_day1",
        stepNumber: 1,
        scheduledAt: new Date(NOW - DAY),
        executedAt: new Date(NOW - DAY),
        result: "email_sent",
      },
      {
        id: `${id}_s2`,
        accountId: ACCOUNT_ID,
        failedPaymentId: id,
        stepType: "email_day3",
        stepNumber: 2,
        scheduledAt: new Date(NOW + 2 * DAY),
      },
    ]);
  }

  let r = 0;
  for (const amount of opts.recoveredThisMonth ?? []) {
    r++;
    await db.insert(recoveredPayments).values({
      id: `rp_m_${r}`,
      accountId: ACCOUNT_ID,
      failedPaymentId: await fp(amount, "recovered"),
      recoveredAt: new Date(Date.UTC(2026, 6, 10)),
      amountCents: amount,
      currency: "usd",
      recoveryMethod: "retry",
      attributionKind: "foxhound_retry",
    });
  }
  for (const amount of opts.recoveredEarlier ?? []) {
    r++;
    await db.insert(recoveredPayments).values({
      id: `rp_e_${r}`,
      accountId: ACCOUNT_ID,
      failedPaymentId: await fp(amount, "recovered"),
      recoveredAt: new Date(Date.UTC(2026, 4, 10)),
      amountCents: amount,
      currency: "usd",
      recoveryMethod: "retry",
      attributionKind: "foxhound_retry",
    });
  }

  let d = 0;
  for (const offset of opts.disputeDeadlines ?? []) {
    d++;
    await db.insert(disputes).values({
      id: `d_${d}`,
      accountId: ACCOUNT_ID,
      stripeDisputeId: `dp_${d}`,
      stripeChargeId: `ch_${d}`,
      customerName: `Disputer ${d}`,
      amountCents: 5000,
      currency: "usd",
      reason: "fraudulent",
      status: "needs_response",
      state: "pending_review",
      evidenceDeadline: offset === null ? null : new Date(NOW + offset),
      createdAt: new Date(NOW - DAY),
    });
  }
  for (let i = 0; i < (opts.resolvedDisputes ?? 0); i++) {
    d++;
    await db.insert(disputes).values({
      id: `d_${d}`,
      accountId: ACCOUNT_ID,
      stripeDisputeId: `dp_${d}`,
      stripeChargeId: `ch_${d}`,
      amountCents: 5000,
      currency: "usd",
      reason: "fraudulent",
      status: "won",
      state: "resolved_won",
      evidenceDeadline: new Date(NOW + HOUR),
      createdAt: new Date(NOW - 10 * DAY),
    });
  }

  let c = 0;
  for (const row of opts.atRisk ?? []) {
    c++;
    await db.insert(customerContext).values({
      id: `cc_${c}`,
      accountId: ACCOUNT_ID,
      stripeCustomerId: `cus_ctx_${c}`,
      customerName: `AtRisk ${c}`,
      healthScore: row.score,
      mrrContributionCents: row.mrr,
      currency: "usd",
      createdAt: now,
      updatedAt: now,
    });
  }

  let k = 0;
  for (const monthsOut of opts.cardMonthsOut ?? []) {
    k++;
    const at = new Date(NOW);
    at.setUTCMonth(at.getUTCMonth() + monthsOut);
    await db.insert(expiringCardAlerts).values({
      id: `card_${k}`,
      accountId: ACCOUNT_ID,
      stripeCustomerId: `cus_card_${k}`,
      customerEmail: `card${k}@example.com`,
      customerName: `CardHolder ${k}`,
      expiresMonth: at.getUTCMonth() + 1,
      expiresYear: at.getUTCFullYear(),
      createdAt: now,
    });
  }

  if (opts.audit) {
    await db.insert(auditRuns).values({
      id: "audit_1",
      accountId: ACCOUNT_ID,
      runAt: new Date(NOW - opts.audit.daysAgo * DAY),
      lookbackDays: 90,
      failedInvoicesCents: opts.audit.failedCents,
      openDisputesCents: opts.audit.disputeCents,
      createdAt: now,
    });
  }
  return db;
}

describe("getConsoleView hero", () => {

  it("counts only this month's recoveries as protected, but all time in the subtext", async () => {
    const db = await seedConsole({ recoveredThisMonth: [1000, 2000], recoveredEarlier: [9999] });
    const view = await getConsoleView(db, ACCOUNT_ID, NOW, 50);
    expect(view.hero.protectedThisMonth).toEqual([{ currency: "usd", cents: 3000 }]);
    expect(view.hero.recoveredAllTimeCount).toBe(3);
  });

  it("counts unresolved disputes only", async () => {
    const db = await seedConsole({ disputeDeadlines: [HOUR, 5 * DAY], resolvedDisputes: 3 });
    const view = await getConsoleView(db, ACCOUNT_ID, NOW, 10);
    expect(view.hero.openDisputeCount).toBe(2);
  });
});

describe("getConsoleView tiles", () => {
  it("marks Recovery unconnected when there is no Stripe connection", async () => {
    const db = await seedConsole({ connected: false });
    expect((await getConsoleView(db, ACCOUNT_ID, NOW, null)).tiles.stripeConnected).toBe(false);
  });

  it("sums audit leakage across both of its components", async () => {
    const db = await seedConsole({ audit: { daysAgo: 3, failedCents: 40_000, disputeCents: 2_500 } });
    const view = await getConsoleView(db, ACCOUNT_ID, NOW, null);
    expect(view.tiles.auditLeakingCents).toBe(42_500);
    expect(view.tiles.lastAuditAt).not.toBeNull();
  });
});

describe("getConsoleView attention feed", () => {

  it("puts urgent dispute deadlines before warnings and subtle rows", async () => {
    const db = await seedConsole({
      disputeDeadlines: [HOUR],
      atRisk: [{ score: 20, mrr: 9900 }],
      cardMonthsOut: [0],
      entitled: true,
    });
    const view = await getConsoleView(db, ACCOUNT_ID, NOW, null);
    const tones = view.attention.map((r) => r.tone);
    expect(tones[0]).toBe("urgent");
    expect(tones).toContain("warning");
    expect(tones).toContain("subtle");
    // Urgent never appears after a subtle row.
    expect(tones.lastIndexOf("urgent")).toBeLessThan(tones.indexOf("subtle"));
  });

  it("orders at-risk customers by MRR and carries the amount for the row", async () => {
    const db = await seedConsole({
      atRisk: [
        { score: 30, mrr: 1_000 },
        { score: 10, mrr: 50_000 },
        { score: 35, mrr: 20_000 },
      ],
      entitled: true,
    });
    const view = await getConsoleView(db, ACCOUNT_ID, NOW, null);
    const rows = view.attention.filter((r) => r.key.startsWith("at-risk-"));
    expect(rows.map((r) => r.mrrCents)).toEqual([50_000, 20_000, 1_000]);
  });

  it("collapses more than three exhausted sequences into a trailing row", async () => {
    const db = await seedConsole({});
    // Five active payments whose only step already ran: all exhausted.
    for (let i = 1; i <= 5; i++) {
      const id = `ex_${i}`;
      await db.insert(failedPayments).values({
        id,
        accountId: ACCOUNT_ID,
        stripeEventId: `xevt_${i}`,
        stripeInvoiceId: `xin_${i}`,
        stripeCustomerId: `xcus_${i}`,
        customerEmail: `x${i}@example.com`,
        customerName: `Stalled ${i}`,
        amountCents: 1000,
        currency: "usd",
        declineCategory: "soft",
        status: "active",
        detectedAt: new Date(NOW - 40 * DAY),
        isRenewalNoise: false,
      });
      await db.insert(recoverySteps).values({
        id: `${id}_s1`,
        accountId: ACCOUNT_ID,
        failedPaymentId: id,
        stepType: "email_day1",
        stepNumber: 1,
        scheduledAt: new Date(NOW - 39 * DAY),
        executedAt: new Date(NOW - 39 * DAY),
        result: "email_sent",
      });
    }
    const view = await getConsoleView(db, ACCOUNT_ID, NOW, null);
    const rows = view.attention.filter((r) => r.key.startsWith("exhausted"));
    expect(rows).toHaveLength(4);
    expect(rows.at(-1)!.key).toBe("exhausted-more");
    expect(rows.at(-1)!.subject).toBe("and 2 more");
  });

  it("does not treat a payment with a pending future step as exhausted", async () => {
    const db = await seedConsole({ activeAmounts: [1000] });
    const view = await getConsoleView(db, ACCOUNT_ID, NOW, null);
    expect(view.attention.filter((r) => r.key.startsWith("exhausted"))).toEqual([]);
  });

  it("links an expiring card to the customer only when Intelligence is entitled", async () => {
    const withIntel = await seedConsole({ cardMonthsOut: [0], entitled: true });
    const a = await getConsoleView(withIntel, ACCOUNT_ID, NOW, null);
    expect(a.attention.find((r) => r.key.startsWith("card-"))?.href).toContain("/intelligence/customers/");

    const withoutIntel = await seedConsole({ cardMonthsOut: [0], entitled: false });
    const b = await getConsoleView(withoutIntel, ACCOUNT_ID, NOW, null);
    expect(b.attention.find((r) => r.key.startsWith("card-"))?.href).toBeNull();
  });

  it("omits a card expiring far in the future", async () => {
    const db = await seedConsole({ cardMonthsOut: [6] });
    const view = await getConsoleView(db, ACCOUNT_ID, NOW, null);
    expect(view.attention.filter((r) => r.key.startsWith("card-"))).toEqual([]);
  });
});
