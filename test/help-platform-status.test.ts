import { describe, expect, it } from "vitest";

import { cronRuns } from "~/db";
import { cronDisplayStatus, getVisibleCronStatus } from "~/lib/help/platform-status.server";

import { createInMemoryDb } from "./helpers/inmemory-db";

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
  it("takes the last SUCCESS for the time-ago and the newest run for the status", async () => {
    // The discriminating case: a cron that succeeded an hour ago and failed
    // five minutes ago must read as an error while still reporting the real
    // last success.
    const { db } = createInMemoryDb();
    await db.insert(cronRuns).values({
      name: "recovery-tick",
      everyMinutes: 5,
      lastOkAt: NOW - 60 * 60_000,
      lastFailedAt: NOW - 5 * 60_000,
    });
    const row = (await getVisibleCronStatus(db, NOW)).find((r) => r.cronName === "recovery-tick")!;
    expect(row.status).toBe("error");
    expect(row.lastSucceededAt?.getTime()).toBe(NOW - 60 * 60_000);
  });
});
