import { describe, expect, it } from "vitest";

import { backupStatus, runD1Backup } from "~/lib/backup/d1-backup";
import { CRON_JOBS } from "~/lib/cron/registry";
import { CRON_SCHEDULE_DAILY } from "~/lib/constants";

describe("runD1Backup and backupStatus without a bucket", () => {
  it("the job fails loudly while BACKUPS is unbound", async () => {
    await expect(runD1Backup({} as Env, new Date())).rejects.toThrow(/BACKUPS R2 binding/);
  });

  it("health says so instead of reporting a fake age", async () => {
    const status = await backupStatus({} as Env);
    expect(status.age_hours).toBeNull();
    expect(status.warning).toMatch(/no backup bucket/);
  });

  it("PLANT: a stale dump (30 hours old) warns", async () => {
    const exported = new Date("2026-10-08T03:00:00.000Z").toISOString();
    const marker = JSON.stringify({ exported_at: exported, keys: [], tables: [], fts: [], excluded: [] });
    const bucket = {
      put: async () => undefined,
      get: async () => ({ text: async () => marker }),
      list: async () => ({ objects: [{ key: "backups/json/2026-10-08T03-00-00Z/_complete.json" }], truncated: false }),
    };
    const status = await backupStatus({ BACKUPS: bucket } as unknown as Env, new Date("2026-10-09T09:00:00.000Z"));
    expect(status.warning).toMatch(/30h ago/);
    expect(status.age_hours).toBeGreaterThan(26);
  });
});

describe("registration", () => {
  it("d1-backup runs on the existing daily schedule", () => {
    const job = CRON_JOBS.find((j) => j.name === "d1-backup");
    expect(job?.schedule).toBe(CRON_SCHEDULE_DAILY);
  });
});
