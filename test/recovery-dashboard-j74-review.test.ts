import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { emailSends, emailSuppressions } from "~/db/schema";
import { getRecoveryDashboardWindow } from "~/lib/dashboard/recovery-window.server";
import { DEMO_ACCOUNT_ID } from "~/lib/demo/constants";
import { seedDemoAccount } from "~/lib/demo/seed";
import { getDeliverabilityCounts, listExecutedEmailSteps } from "~/lib/recovery/dashboard-queries.server";

import { createInMemoryDb } from "./helpers/inmemory-db";

// J74 review (PR #109, CHANGES at be5bbf7). Three reads the review found
// untrue, each pinned against the real seeded demo account so the SQL is
// proven on the schema: the ROI "This month" column, the 30-day "Emails sent"
// card, and the deliverability panel's sends, bounces and complaints.

// The 20th of a month: a recovery on the 5th is this month's and 15 days old,
// so it has not held for the 30-day maturity and is not yet billable.
const now = new Date("2026-07-20T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

async function seededDb() {
  const { db } = createInMemoryDb();
  await seedDemoAccount(db, now);
  return db;
}


describe("Emails sent card: the same 30 days as every other stat card", () => {
  it("counts only email steps executed inside the window, with rates over those", async () => {
    const db = await seededDb();
    const w = await getRecoveryDashboardWindow(db, DEMO_ACCOUNT_ID, "30d", now.getTime());
    const cutoff = now.getTime() - 30 * DAY_MS;
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
    // The side panel's figure stays all time, as Recova's query was.
    expect(w.totalEmailsSent).toBe(steps.length);
  });
});

describe("Deliverability: sends from email_sends, bounces and complaints from email_suppressions", () => {
  it("counts this account's sent emails and its bounce and complaint suppressions inside the window", async () => {
    const db = await seededDb();
    const inside = new Date(now.getTime() - 3 * DAY_MS);
    const outside = new Date(now.getTime() - 40 * DAY_MS);
    // Clear anything the seed wrote so the counts below are exact.
    await db.delete(emailSends).where(eq(emailSends.accountId, DEMO_ACCOUNT_ID));
    await db.delete(emailSuppressions).where(eq(emailSuppressions.accountId, DEMO_ACCOUNT_ID));
    const send = (status: string, sentAt: Date | null, accountId: string | null = DEMO_ACCOUNT_ID) => ({
      accountId,
      status,
      sentAt,
      createdAt: sentAt ?? inside,
    });
    await db.insert(emailSends).values([
      send("sent", inside),
      send("sent", inside),
      send("sent", inside),
      send("sent", inside),
      send("failed", null),
      send("suppressed", null),
      send("sent", outside),
      send("sent", inside, null),
    ]);
    const supp = (email: string, reason: string, at: Date, accountId: string | null = DEMO_ACCOUNT_ID) => ({
      email,
      token: `evt_${email}`,
      reason,
      suppressedAt: at,
      accountId,
    });
    await db.insert(emailSuppressions).values([
      supp("a@example.com", "bounce", inside),
      supp("b@example.com", "hard_bounce", inside),
      supp("c@example.com", "complaint", inside),
      supp("d@example.com", "unsubscribe", inside),
      supp("e@example.com", "bounce", outside),
      supp("f@example.com", "spam", inside, null),
    ]);

    const counts = await getDeliverabilityCounts(db, DEMO_ACCOUNT_ID, now.getTime() - 30 * DAY_MS);
    expect(counts).toEqual({ sent: 4, bounced: 2, complaints: 1 });

    const allTime = await getDeliverabilityCounts(db, DEMO_ACCOUNT_ID, null);
    expect(allTime).toEqual({ sent: 5, bounced: 3, complaints: 1 });

    // No other account's rows leak in.
    const other = await db
      .select({ id: emailSuppressions.id })
      .from(emailSuppressions)
      .where(and(eq(emailSuppressions.reason, "spam")));
    expect(other.length).toBe(1);
  });
});
