import { readFileSync } from "node:fs";

import type { DumpResult } from "@dustinedwards/d1-dump";
import { describe, expect, it } from "vitest";

import {
  assertDumpIsSafe,
  BACKUP_EXCLUDED_TABLES,
  BackupVerificationError,
  backupStatus,
  runD1Backup,
} from "~/lib/backup/d1-backup";
import { CRON_JOBS } from "~/lib/cron/registry";
import { CRON_SCHEDULE_DAILY } from "~/lib/constants";

function dump(tables: Array<[string, number]>): DumpResult {
  return {
    run_id: "r",
    prefix: "backups/json/r/",
    exported_at: "2026-10-09T03:00:00.000Z",
    keys: [],
    tables: tables.map(([name, rows]) => ({ name, rows, key: `k/${name}.json` })),
    fts: [],
    excluded: [...BACKUP_EXCLUDED_TABLES],
    shadow_skipped: [],
    complete: false,
  };
}

const GOOD: Array<[string, number]> = [
  ["accounts", 3],
  ["stripe_connections", 2],
  ["failed_payments", 10],
  ["user", 4],
];

describe("assertDumpIsSafe", () => {
  it("passes a real dump without credential tables", () => {
    expect(() => assertDumpIsSafe(dump(GOOD))).not.toThrow();
  });

  it("PLANT: an empty dump (no tables) is refused", () => {
    expect(() => assertDumpIsSafe(dump([]))).toThrow(BackupVerificationError);
  });

  it("PLANT: tables with zero rows are refused", () => {
    expect(() => assertDumpIsSafe(dump(GOOD.map(([n]) => [n, 0])))).toThrow(/no rows/);
  });

  it.each(BACKUP_EXCLUDED_TABLES)("PLANT: credential table %s left in the dump is refused", (table) => {
    expect(() => assertDumpIsSafe(dump([...GOOD, [table, 5]]))).toThrow(new RegExp(`"${table}"`));
  });

  it("PLANT: a dump missing stripe_connections is refused (encrypted tokens must be kept)", () => {
    expect(() => assertDumpIsSafe(dump(GOOD.filter(([n]) => n !== "stripe_connections")))).toThrow(
      /stripe_connections/,
    );
  });
});

describe("excluded tables match the schema", () => {
  it("each excluded table is a real Better Auth table", () => {
    const schema = readFileSync("app/db/auth-schema.ts", "utf8");
    for (const table of BACKUP_EXCLUDED_TABLES) {
      expect(schema).toContain(`sqliteTable(\n  "${table}"`);
    }
  });
});

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
