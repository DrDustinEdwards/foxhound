import { describe, expect, it } from "vitest";

import { accounts, cronConfig } from "~/db";
import { isKnownCronName, setCronEnabled } from "~/lib/admin/crons.server";
import { isCronEnabled } from "~/lib/cron/gating";
import { CRON_JOBS } from "~/lib/cron/registry";

import { createInMemoryDb } from "./helpers/inmemory-db";

// setCronEnabled accepted any string. Combined with the rule that a MISSING
// cron_config row means ENABLED, a typo produced the worst kind of silent
// failure: the operator got a success, a row existed and read as disabled on
// inspection, it gated nothing, and the real job kept running.

describe("isKnownCronName", () => {
  // Derived from the registry itself rather than a hand-copied list: a coverage
  // test whose expected set comes from a second transcription proves nothing.
  it("accepts every registered job", () => {
    expect(CRON_JOBS.length).toBeGreaterThan(0);
    for (const job of CRON_JOBS) {
      expect(isKnownCronName(job.name), job.name).toBe(true);
    }
  });

  // Sweep the shapes a typo actually takes, not one arbitrary string.
  it("rejects the ways a real name gets mistyped", () => {
    const real = CRON_JOBS[0].name;
    const typos = [
      "",
      "  ",
      `${real} `,
      ` ${real}`,
      real.toUpperCase(),
      real.replace("-", "_"),
      real.slice(0, -1),
      `${real}s`,
      "demo_reset",
      "recovery_tick",
      "nonexistent-cron",
      "'; DROP TABLE cron_config; --",
    ];
    for (const t of typos) {
      expect(isKnownCronName(t), JSON.stringify(t)).toBe(false);
    }
  });
});

describe("setCronEnabled refuses an unknown name", () => {
  async function db() {
    const { db } = createInMemoryDb();
    await db.insert(accounts).values({ id: "acct_1", name: "A", createdAt: new Date() });
    return db;
  }

  it("writes no row for a mistyped name", async () => {
    const d = await db();
    await expect(setCronEnabled(d, "demo_reset", false)).rejects.toThrow(/unknown cron name/);
    const rows = await d.select().from(cronConfig);
    expect(rows).toEqual([]);
  });

  // The heart of it: the phantom row would have gated nothing while the real job
  // kept running, because a missing row means enabled.
  it("leaves the real job enabled after a mistyped disable", async () => {
    const d = await db();
    const real = CRON_JOBS.find((j) => j.name === "demo-reset")!;
    await expect(setCronEnabled(d, "demo_reset", false)).rejects.toThrow();

    const rows = await d.select().from(cronConfig);
    const configForReal = rows.find((r) => r.cronName === real.name) ?? null;
    // No config row for the real job, and a missing row means enabled: exactly
    // the state the operator thought they had changed.
    expect(configForReal).toBeNull();
    expect(isCronEnabled(configForReal)).toBe(true);
  });

  it("still disables a correctly named job", async () => {
    const d = await db();
    const real = CRON_JOBS[0].name;
    await setCronEnabled(d, real, false);
    const rows = await d.select().from(cronConfig);
    expect(rows).toHaveLength(1);
    expect(rows[0].cronName).toBe(real);
    expect(isCronEnabled({ enabled: rows[0].enabled, minIntervalMinutes: rows[0].minIntervalMinutes })).toBe(false);
  });

  it("re-enables an already-configured job without duplicating the row", async () => {
    const d = await db();
    const real = CRON_JOBS[0].name;
    await setCronEnabled(d, real, false);
    await setCronEnabled(d, real, true);
    const rows = await d.select().from(cronConfig);
    expect(rows).toHaveLength(1);
    expect(rows[0].enabled).toBe(true);
  });
});
