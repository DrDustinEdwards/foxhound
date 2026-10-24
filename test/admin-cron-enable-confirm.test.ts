import { describe, expect, it, vi } from "vitest";

import { cronEnableConfirmPhrase, isCronEnableConfirmValid } from "~/lib/admin/brake";
import { adminContext } from "~/lib/admin/context";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { RECOVERY_TICK_CRON_NAME } from "~/lib/constants";
import { CRON_JOBS } from "~/lib/cron/registry";

import { createInMemoryDb } from "./helpers/inmemory-db";

// Review MEDIUM-4. app/lib/admin/brake.ts asserted "every destructive control is
// gated on typing its exact phrase, no single-click path exists for any of
// them". That was true of the brake panel and false of the platform: the same
// recovery tick could be restarted in one click from /admin/crons, while the
// brake panel went on rendering "Tick DISABLED" from its own stale loader data.
//
// The asymmetry is the rule being pinned, not just the recovery tick's case:
// ENABLE is gated for every registered cron, DISABLE is one click for every one
// of them.

const harness = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const { action } = await import("~/routes/admin/crons");
const schema = await import("~/db/schema");
const { isCronEnabled } = await import("~/lib/cron/gating");

const ACTOR = "admin@foxhoundapp.com";

/** The two context keys the action reads, and nothing else. */
const fakeContext = {
  get(key: unknown) {
    if (key === cloudflareContext) return { env: {} as Env, ctx: {} as ExecutionContext, nonce: "n" };
    if (key === adminContext) return { email: ACTOR };
    throw new Error("unexpected context key");
  },
} as unknown as Parameters<typeof action>[0]["context"];

function post(fields: Record<string, string>) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.append(k, v);
  return new Request("http://localhost/admin/crons", { method: "POST", body });
}

async function run(fields: Record<string, string>) {
  const { db } = createInMemoryDb();
  harness.db = db;
  const result = await action({ context: fakeContext, request: post(fields), params: {} } as never);
  return { db, result: result as unknown as { data: { error?: string; ok?: boolean }; init?: ResponseInit } };
}

async function stateOf(db: Awaited<ReturnType<typeof run>>["db"], cronName: string) {
  const rows = await db.select().from(schema.cronConfig);
  const row = rows.find((r) => r.cronName === cronName) ?? null;
  return { rowExists: row !== null, enabled: isCronEnabled(row) };
}

async function auditRows(db: Awaited<ReturnType<typeof run>>["db"]) {
  return db.select().from(schema.adminAuditLog);
}

describe("the phrase itself", () => {

  it("is case-sensitive, exact, and tolerates surrounding whitespace only", () => {
    const p = cronEnableConfirmPhrase("recovery-tick");
    expect(isCronEnableConfirmValid("recovery-tick", `  ${p}  `)).toBe(true);
    expect(isCronEnableConfirmValid("recovery-tick", p.toLowerCase())).toBe(false);
    expect(isCronEnableConfirmValid("recovery-tick", "ENABLE")).toBe(false);
    expect(isCronEnableConfirmValid("recovery-tick", "")).toBe(false);
    expect(isCronEnableConfirmValid("recovery-tick", "ENABLE  recovery-tick")).toBe(false);
  });
});

describe("the /admin/crons action enforces the asymmetry", () => {

  it("allows an enable with the exact phrase", async () => {
    const { db, result } = await run({
      cronName: RECOVERY_TICK_CRON_NAME,
      nextEnabled: "true",
      confirm: cronEnableConfirmPhrase(RECOVERY_TICK_CRON_NAME),
    });

    expect(result.data.ok).toBe(true);
    expect(await stateOf(db, RECOVERY_TICK_CRON_NAME)).toEqual({ rowExists: true, enabled: true });
    expect((await auditRows(db)).map((r) => r.action)).toEqual(["cron.enable"]);
  });

  it("gates ENABLE for every registered cron, not only the recovery tick", async () => {
    // billing-monthly moves money on its first ever run; a rule that only
    // covered the tick would leave the more consequential one one click away.
    for (const job of CRON_JOBS) {
      const { db, result } = await run({ cronName: job.name, nextEnabled: "true" });
      expect(result.data.error, job.name).toMatch(/exactly to enable/);
      expect(await auditRows(db), job.name).toEqual([]);
    }
    // 10s for the same reason as the DISABLE case above: 13 fresh databases,
    // each with the full migration set applied.
  }, 10_000);

  it("still rejects an unknown cron name before the confirmation is even considered", async () => {
    const { db, result } = await run({
      cronName: "recovery_tick",
      nextEnabled: "true",
      confirm: "ENABLE recovery_tick",
    });

    expect(result.data.error).toMatch(/Unknown cron/);
    expect(await auditRows(db)).toEqual([]);
  });
});
