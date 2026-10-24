import type Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";

import { BRAKE_CONFIRM_PHRASES } from "~/lib/admin/brake";
import { adminContext } from "~/lib/admin/context";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { RECOVERY_TICK_CRON_NAME } from "~/lib/constants";

import { createInMemoryDb } from "./helpers/inmemory-db";

// Review LOW-4: both cron-toggle paths wrote the STATE and then the AUDIT ROW.
// If the insert failed, the tick's enabled state had changed with nobody
// recorded as having changed it.
//
// applyBrakeTransition (brake.server.ts) reverses exactly this ordering on
// purpose, and its comment explains why: the umbrella row is the intent record,
// and writing it last "meant a mid-loop failure left paused accounts with no
// record that anyone had engaged". The same panel's other control, and
// /admin/crons, did the thing that comment rejects.
//
// The audit failure here is real, not mocked: the table is dropped, so the
// genuine logAdminAction insert throws against the genuine schema.

const harness = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const { action: cronsAction } = await import("~/routes/admin/crons");
const { action: brakeAction } = await import("~/routes/admin/brake");
const schema = await import("~/db/schema");

const ACTOR = "admin@foxhoundapp.com";

const fakeContext = {
  get(key: unknown) {
    if (key === cloudflareContext) return { env: {} as Env, ctx: {} as ExecutionContext, nonce: "n" };
    if (key === adminContext) return { email: ACTOR };
    throw new Error("unexpected context key");
  },
} as unknown as Parameters<typeof cronsAction>[0]["context"];

function post(url: string, fields: Record<string, string>) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.append(k, v);
  return new Request(url, { method: "POST", body });
}

/** A database whose admin_audit_log is gone, so the real audit insert throws. */
function dbWithBrokenAudit(): { db: unknown; sqlite: Database.Database } {
  const { db, sqlite } = createInMemoryDb();
  harness.db = db;
  sqlite.exec("drop table admin_audit_log");
  return { db, sqlite };
}

async function cronRowCount(sqlite: Database.Database) {
  return (sqlite.prepare("select count(*) as n from cron_config").get() as { n: number }).n;
}

describe("LOW-4: /admin/crons writes the intent before the state", () => {
  it("a failed audit insert leaves the cron's enabled state untouched", async () => {
    const { sqlite } = dbWithBrokenAudit();

    await expect(
      cronsAction({
        context: fakeContext,
        request: post("http://localhost/admin/crons", {
          cronName: RECOVERY_TICK_CRON_NAME,
          nextEnabled: "false",
        }),
        params: {},
      } as never),
    ).rejects.toThrow();

    // Nothing was written. Pre-fix, cron_config carried a disabled row that no
    // audit entry accounted for.
    expect(await cronRowCount(sqlite)).toBe(0);
  });
});

describe("LOW-4: the brake panel's tick toggle writes the intent before the state", () => {

  it("still stamps via=brake-panel on the happy path, so the two routes stay distinguishable", async () => {
    // The one thing that already went right here, per the review. Kept pinned
    // because reordering the two writes is exactly when it could be dropped.
    const { db } = createInMemoryDb();
    harness.db = db;

    await brakeAction({
      context: fakeContext,
      request: post("http://localhost/admin/brake", {
        intent: "tick-disable",
        confirm: BRAKE_CONFIRM_PHRASES["tick-disable"],
      }),
      params: {},
    } as never);

    const [row] = await db.select().from(schema.adminAuditLog);
    expect(row.action).toBe("cron.disable");
    expect((row.metadata as { via: string }).via).toBe("brake-panel");
    expect(await db.select().from(schema.cronConfig)).toHaveLength(1);
  });
});
