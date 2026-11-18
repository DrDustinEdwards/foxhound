import { describe, expect, it } from "vitest";

import { diffMigrations, getEnvSanity } from "~/lib/admin/operations.server";

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

  it("fails the Stripe key row when it is not a live key, without quoting it", () => {
    const problem = (key: string) =>
      getEnvSanity({ STRIPE_SECRET_KEY: key } as unknown as Env).find(
        (r) => r.name === "STRIPE_SECRET_KEY",
      )?.problem;
    expect(problem("sk_test_abc123")).toBe("Not a live key");
    expect(problem("sk_live_abc123")).toBeNull();
    expect(problem("rk_live_abc123")).toBeNull();
    expect(
      JSON.stringify(getEnvSanity({ STRIPE_SECRET_KEY: "sk_test_abc123" } as unknown as Env)),
    ).not.toContain("abc123");
  });

  it("covers every DB/DO binding this Worker declares", () => {
    const rows = getEnvSanity({} as Env);
    const names = rows.map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(["DB", "MONEY_WRITER", "CRON_LOCK"]));
  });
});
