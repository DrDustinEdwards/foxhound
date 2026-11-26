import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { emailSends, emailSuppressions } from "~/db/schema";
import {
  atRiskPctOfMrr,
  dailyRecoveredRows,
  onboardingNeeded,
  roiColumn,
} from "~/lib/dashboard/recovery-dashboard";
import { getRecoveryDashboardWindow } from "~/lib/dashboard/recovery-window.server";
import { DEMO_ACCOUNT_ID } from "~/lib/demo/constants";
import { seedDemoAccount } from "~/lib/demo/seed";
import {
  getDeliverabilityCounts,
  listExecutedEmailSteps,
} from "~/lib/recovery/dashboard-queries.server";

import { createInMemoryDb } from "./helpers/inmemory-db";

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

function day(offset: number): string {
  return new Date(NOW - offset * DAY).toISOString().slice(0, 10);
}

describe("dashboard arithmetic", () => {
  it("at-risk share of MRR, one decimal, single currency only", () => {
    expect(atRiskPctOfMrr([{ currency: "usd", cents: 50_000 }], 400_000)).toBe(12.5);
    expect(atRiskPctOfMrr([{ currency: "usd", cents: 50_000 }], null)).toBeNull();
    expect(
      atRiskPctOfMrr(
        [
          { currency: "usd", cents: 1 },
          { currency: "eur", cents: 1 },
        ],
        400_000,
      ),
    ).toBeNull();
  });

  it("ROI fees per recovery, summed per currency", () => {
    const col = roiColumn([
      { amountCents: 1_001, refundedCents: 0, currency: "usd" },
      { amountCents: 1_001, refundedCents: 0, currency: "usd" },
      { amountCents: 500, refundedCents: 0, currency: "eur" },
    ]);
    expect(col.recovered).toEqual([
      { currency: "usd", cents: 2_002 },
      { currency: "eur", cents: 500 },
    ]);
    expect(col.fee).toEqual([
      { currency: "usd", cents: 400 },
      { currency: "eur", cents: 100 },
    ]);
    expect(col.kept[0]).toEqual({ currency: "usd", cents: 1_602 });
  });

  it("daily recovered rows are zero-filled and never mix currencies", () => {
    const { rows, currencies } = dailyRecoveredRows(
      [
        { recoveredAt: new Date(NOW), amountCents: 1_000, currency: "usd" },
        { recoveredAt: new Date(NOW), amountCents: 2_000, currency: "eur" },
      ],
      7,
      NOW,
    );
    expect(currencies).toEqual(["USD", "EUR"]);
    expect(rows).toHaveLength(14);
    expect(rows.at(-2)).toEqual({ Day: day(0), currency: "USD", amount: 10 });
    expect(rows.at(-1)).toEqual({ Day: day(0), currency: "EUR", amount: 20 });
  });

  it("onboarding gate", () => {
    expect(
      onboardingNeeded({
        connected: false,
        senderName: null,
        notificationEmail: null,
        onboardingCompleted: false,
      }),
    ).toBe(true);
    expect(
      onboardingNeeded({
        connected: true,
        senderName: "A",
        notificationEmail: "a@example.com",
        onboardingCompleted: false,
      }),
    ).toBe(false);
    expect(
      onboardingNeeded({
        connected: false,
        senderName: null,
        notificationEmail: null,
        onboardingCompleted: true,
      }),
    ).toBe(false);
  });
});

// Reads proven against the seeded demo account.
const now = new Date("2026-07-20T12:00:00.000Z");

async function seededDb() {
  const { db } = createInMemoryDb();
  await seedDemoAccount(db, now);
  return db;
}

describe("Emails sent card: counts only the 30-day window", () => {
  it("counts only email steps executed inside the window, with rates over those", async () => {
    const db = await seededDb();
    const w = await getRecoveryDashboardWindow(db, DEMO_ACCOUNT_ID, "30d", now.getTime());
    const cutoff = now.getTime() - 30 * DAY;
    const steps = await listExecutedEmailSteps(db, DEMO_ACCOUNT_ID);
    const inWindow = steps.filter((s) => s.executedAt !== null && s.executedAt.getTime() >= cutoff);
    expect(inWindow.length).toBeGreaterThan(0);
    expect(inWindow.length).toBeLessThan(steps.length);

    expect(w.emailsSentInRange.sent).toBe(inWindow.length);
    expect(w.emailsSentInRange.openRatePct).toBe(
      Math.round((inWindow.filter((s) => s.openedAt).length / inWindow.length) * 100),
    );
    expect(w.emailsSentInRange.clickRatePct).toBe(
      Math.round((inWindow.filter((s) => s.clickedAt).length / inWindow.length) * 100),
    );
    expect(w.totalEmailsSent).toBe(steps.length);
  });
});

describe("Deliverability: sends from email_sends, bounces and complaints from email_suppressions", () => {
  it("counts this account's sent emails and its bounce and complaint suppressions inside the window", async () => {
    const db = await seededDb();
    const inside = new Date(now.getTime() - 3 * DAY);
    const outside = new Date(now.getTime() - 40 * DAY);
    // Clear anything the seed wrote so the counts below are exact.
    await db.delete(emailSends).where(eq(emailSends.accountId, DEMO_ACCOUNT_ID));
    await db.delete(emailSuppressions).where(eq(emailSuppressions.accountId, DEMO_ACCOUNT_ID));
    const send = (
      status: string,
      sentAt: Date | null,
      accountId: string | null = DEMO_ACCOUNT_ID,
    ) => ({
      accountId,
      status,
      sentAt,
      createdAt: sentAt ?? inside,
    });
    await db
      .insert(emailSends)
      .values([
        send("sent", inside),
        send("sent", inside),
        send("sent", inside),
        send("sent", inside),
        send("failed", null),
        send("suppressed", null),
        send("sent", outside),
        send("sent", inside, null),
      ]);
    const supp = (
      email: string,
      reason: string,
      at: Date,
      accountId: string | null = DEMO_ACCOUNT_ID,
    ) => ({
      email,
      token: `evt_${email}`,
      reason,
      suppressedAt: at,
      accountId,
    });
    await db
      .insert(emailSuppressions)
      .values([
        supp("a@example.com", "hard_bounce", inside),
        supp("b@example.com", "hard_bounce", inside),
        supp("c@example.com", "complaint", inside),
        supp("d@example.com", "unsubscribe", inside),
        supp("e@example.com", "hard_bounce", outside),
        supp("f@example.com", "complaint", inside, null),
      ]);

    const counts = await getDeliverabilityCounts(db, DEMO_ACCOUNT_ID, now.getTime() - 30 * DAY);
    expect(counts).toEqual({ sent: 4, bounced: 2, complaints: 1 });

    const allTime = await getDeliverabilityCounts(db, DEMO_ACCOUNT_ID, null);
    expect(allTime).toEqual({ sent: 5, bounced: 3, complaints: 1 });
  });
});
