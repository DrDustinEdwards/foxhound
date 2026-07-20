import { describe, expect, it } from "vitest";

import { formatBytes } from "~/lib/admin/format";
import { diffMigrations, getEnvSanity } from "~/lib/admin/operations.server";
import { versionIdsToPrune } from "~/lib/blog/admin-queries.server";

describe("formatBytes", () => {
  it("renders sub-1KB sizes as whole bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
  });

  it("renders KB/MB/GB with 2 decimals under 10, 1 decimal at or above 10", () => {
    expect(formatBytes(1024)).toBe("1.00 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.00 MB");
    expect(formatBytes(15 * 1024 * 1024)).toBe("15.0 MB");
    expect(formatBytes(1024 * 1024 * 1024)).toBe("1.00 GB");
  });
});

describe("diffMigrations", () => {
  const known = ["0000_a.sql", "0001_b.sql", "0002_c.sql"] as const;

  it("marks every known migration applied when all are present", () => {
    const applied = new Map([
      ["0000_a.sql", "2026-01-01 00:00:00"],
      ["0001_b.sql", "2026-01-02 00:00:00"],
      ["0002_c.sql", "2026-01-03 00:00:00"],
    ]);
    const { rows, unexpectedApplied } = diffMigrations(known, applied);
    expect(rows.every((r) => r.applied)).toBe(true);
    expect(unexpectedApplied).toEqual([]);
  });

  it("flags a known migration that never ran against this database", () => {
    const applied = new Map([["0000_a.sql", "2026-01-01 00:00:00"]]);
    const { rows } = diffMigrations(known, applied);
    const missing = rows.find((r) => r.name === "0002_c.sql");
    expect(missing?.applied).toBe(false);
    expect(missing?.appliedAt).toBeNull();
  });

  it("flags an applied migration that isn't in the known list", () => {
    const applied = new Map([
      ["0000_a.sql", "2026-01-01 00:00:00"],
      ["9999_mystery.sql", "2026-06-01 00:00:00"],
    ]);
    const { unexpectedApplied } = diffMigrations(known, applied);
    expect(unexpectedApplied).toEqual(["9999_mystery.sql"]);
  });
});

describe("getEnvSanity", () => {
  it("reports set vs not-set by presence, never the value", () => {
    const env = { ADMIN_EMAIL: "ops@example.com", STRIPE_SECRET_KEY: undefined } as unknown as Env;
    const rows = getEnvSanity(env);
    const adminRow = rows.find((r) => r.name === "ADMIN_EMAIL");
    const stripeRow = rows.find((r) => r.name === "STRIPE_SECRET_KEY");
    expect(adminRow?.set).toBe(true);
    expect(stripeRow?.set).toBe(false);
    // The row must never carry the actual value anywhere in its shape.
    expect(JSON.stringify(rows)).not.toContain("ops@example.com");
  });

  it("covers every DB/APP_KV/DO binding this Worker declares", () => {
    const rows = getEnvSanity({} as Env);
    const names = rows.map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(["DB", "APP_KV", "MONEY_WRITER", "CRON_LOCK"]));
  });
});

describe("versionIdsToPrune", () => {
  it("keeps everything when under the retention count", () => {
    expect(versionIdsToPrune(["a", "b"], 10)).toEqual([]);
  });

  it("keeps exactly the retention count with none to prune", () => {
    const ten = Array.from({ length: 10 }, (_, i) => `v${i}`);
    expect(versionIdsToPrune(ten, 10)).toEqual([]);
  });

  it("prunes everything past the retention count, oldest-first input order preserved", () => {
    const eleven = Array.from({ length: 11 }, (_, i) => `v${i}`); // newest-first
    expect(versionIdsToPrune(eleven, 10)).toEqual(["v10"]);
  });
});
