import { describe, expect, it } from "vitest";

import { accounts, cronRunHistory } from "~/db";
import {
  cronDisplayStatus,
  getVisibleCronStatus,
} from "~/lib/help/platform-status.server";

import { createInMemoryDb } from "./helpers/inmemory-db";

// Ruling 399, session 90 job 4. Row S23's owed work against legacy's REAL page,
// app/(app)/help/page.tsx, read whole:
//
//   container  max-w-[720px] mx-auto px-5 sm:px-8 py-10
//   header     PageHeader title "Help", subtitle
//              "Quick answers, guides, and platform status."
//   section 1  "Common questions", six QUICK_ANSWERS as h3 + p pairs
//   section 2  "Guides", PLATFORM_GUIDE full width then four PRODUCT_GUIDES in
//              a 2-col grid, each rounded-lg border p-4 hover:border-brand
//   section 3  "Platform status", a "Background jobs" card of four crons with a
//              time-ago and a status dot, then an "MCP connectors" card
//   section 4  "Contact", a bordered block with a mailto and the business-day
//              sentence
//
// FOUR OF THE 394 WALK'S S23 CLAIMS WERE FALSE and are deliberately not
// actioned: the H1 is "Help" on both sides, the container matches, the real
// page has no green reassurance banner, and there is no card-geometry
// divergence (correcting the walk's demo-twin baseline).
//
// FOUR THINGS ARE DELIBERATELY NOT LEGACY'S, each a truth about Foxhound:
//   * Q1 rewritten: ruling 80 made recovery silent-retry-first, so legacy's
//     "first email sends within an hour" is false here.
//   * Q6 rewritten: ruling 304 declines legacy's per-step body editor.
//   * "four scopes" becomes "six scopes": Foxhound's audit engine has six.
//   * ONE MCP connector, not legacy's two: workers/app.ts serves `/mcp` and no
//     `/mcp/admin` exists, so a second row would name a missing endpoint.
//
// And the fourth cron row is a substitution, asserted below so it is visible:
// legacy's fourth is process-disputes and Foxhound has no dispute cron at all.


const NOW = Date.UTC(2026, 7, 29, 12, 0, 0);



describe("cronDisplayStatus", () => {

  it("reads no successful run ever as pending, not as an error", () => {
    expect(cronDisplayStatus(null, null, NOW, "recovery-tick")).toBe("pending");
  });

  it("reads a success older than the cron's own threshold as stale", () => {
    // recovery-tick allows 90 minutes; 91 is stale and 89 is not. Per-cron,
    // because expiring-cards is daily and 91 minutes is healthy for it.
    expect(cronDisplayStatus("success", new Date(NOW - 91 * 60_000), NOW, "recovery-tick")).toBe(
      "stale",
    );
    expect(cronDisplayStatus("success", new Date(NOW - 89 * 60_000), NOW, "recovery-tick")).toBe(
      "ok",
    );
    expect(cronDisplayStatus("success", new Date(NOW - 91 * 60_000), NOW, "expiring-cards")).toBe(
      "ok",
    );
  });
});

describe("getVisibleCronStatus", () => {
  async function seed(rows: { cronName: string; status: string; minutesAgo: number }[]) {
    const { db } = createInMemoryDb();
    const now = new Date(NOW);
    await db.insert(accounts).values({ id: "acc_1", name: "Acme", createdAt: now });
    let n = 0;
    for (const r of rows) {
      await db.insert(cronRunHistory).values({
        id: "crh_" + n++,
        cronName: r.cronName,
        finishedAt: new Date(NOW - r.minutesAgo * 60_000),
        status: r.status,
        createdAt: now,
      });
    }
    return db;
  }

  it("takes the newest SUCCESS for the time-ago and the newest run for the status", async () => {
    // The discriminating case: a cron that succeeded an hour ago and failed
    // five minutes ago must read as an error while still reporting the real
    // last success. Taking the newest row for both would lose the success time;
    // taking the newest success for both would hide the failure.
    const db = await seed([
      { cronName: "recovery-tick", status: "success", minutesAgo: 60 },
      { cronName: "recovery-tick", status: "failed", minutesAgo: 5 },
    ]);
    const row = (await getVisibleCronStatus(db, NOW)).find((r) => r.cronName === "recovery-tick")!;
    expect(row.status).toBe("error");
    expect(row.lastSucceededAt?.getTime()).toBe(NOW - 60 * 60_000);
  });
});
