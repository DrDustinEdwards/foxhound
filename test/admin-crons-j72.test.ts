
import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { listCronRows } from "~/lib/admin/crons.server";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { RECOVERY_TICK_CRON_NAME } from "~/lib/constants";
import { CRON_JOBS } from "~/lib/cron/registry";

import { createInMemoryDb } from "./helpers/inmemory-db";

// J72 (job_a64949b43595): /admin/platform/crons on the family admin pattern
// (Capsomer patterns, Dustin's Q9 of 2026-10-14) and his 2026-10-11 admin
// review, with Recova's crons page read as the inventory
// (app/admin/platform/crons/page.tsx and CronControlClient.tsx, blobs 98fc42ff
// and 9a820fd4): one table of every cron with its on or off state, the last
// run's status pill, when it last succeeded and the last message, and a note
// when a cron has never been switched (Recova's "no config row"). Enable stays
// behind its typed phrase (APPROVED-DIFFERENCES, 2026-09-19) on Capsomer's
// confirm page; "Run now" stays out (ruling 406 binding 5).

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const route: Record<string, unknown> = await import("~/routes/admin/crons");

const NOW = Date.UTC(2026, 9, 15, 18, 0, 0);
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

type Sqlite = ReturnType<typeof createInMemoryDb>["sqlite"];

function insertRun(sqlite: Sqlite, id: string, cronName: string, status: string, at: number, message: string | null = null) {
  sqlite
    .prepare(
      "insert into cron_run_history (id, cron_name, started_at, finished_at, status, rows_processed, message, created_at) values (?, ?, ?, ?, ?, 0, ?, ?)",
    )
    .run(id, cronName, at - 1000, at, status, message, at);
}

describe("listCronRows reads each cron's own history", () => {
  it("finds a daily job's last run behind a day of five-minute ticks", async () => {
    // The recovery tick and the win-back send each write a row every five
    // minutes: 576 a day between them. A daily job that ran 23 hours ago sits
    // behind more than 500 newer rows, and a monthly job far behind that.
    const { db, sqlite } = createInMemoryDb();
    insertRun(sqlite, "r-digest", "cron-health", "success", NOW - 23 * HOUR, "all due");
    insertRun(sqlite, "r-month", "billing-monthly", "success", NOW - 14 * DAY, "3 accounts");
    const tx = sqlite.transaction(() => {
      for (let i = 0; i < 23 * 12; i += 1) {
        insertRun(sqlite, `t-${i}`, RECOVERY_TICK_CRON_NAME, "success", NOW - i * 5 * MIN);
        insertRun(sqlite, `w-${i}`, "winback-send", "success", NOW - i * 5 * MIN);
      }
    });
    tx();

    const rows = await listCronRows(db, NOW);
    const health = rows.find((r) => r.name === "cron-health");
    expect(health?.lastRun?.id).toBe("r-digest");
    expect(health?.lastRun?.message).toBe("all due");
    expect(rows.find((r) => r.name === "billing-monthly")?.lastRun?.id).toBe("r-month");
    expect(rows.find((r) => r.name === RECOVERY_TICK_CRON_NAME)?.lastRun?.id).toBe("t-0");
  });

  it("says when each cron last succeeded, apart from its last run", async () => {
    const { db, sqlite } = createInMemoryDb();
    insertRun(sqlite, "ok-old", "weekly-digest", "success", NOW - 8 * DAY);
    insertRun(sqlite, "ok-new", "weekly-digest", "success", NOW - 7 * DAY);
    insertRun(sqlite, "bad", "weekly-digest", "failed", NOW - 2 * HOUR, "Email binding unavailable");
    insertRun(sqlite, "bad-only", "d1-backup", "failed", NOW - 3 * HOUR, "R2 down");

    const rows = await listCronRows(db, NOW);
    const digest = rows.find((r) => r.name === "weekly-digest");
    expect(digest?.lastRun?.status).toBe("failed");
    expect(digest?.lastSucceededAt).toEqual(new Date(NOW - 7 * DAY));
    expect(rows.find((r) => r.name === "d1-backup")?.lastSucceededAt).toBeNull();
    expect(rows.find((r) => r.name === "expiring-cards")?.lastSucceededAt).toBeNull();
  });

  it("keeps the last day's failures, newest first, and drops older ones", async () => {
    const { db, sqlite } = createInMemoryDb();
    insertRun(sqlite, "f1", "weekly-digest", "failed", NOW - 1 * HOUR, "one");
    insertRun(sqlite, "f2", "weekly-digest", "failed", NOW - 5 * HOUR, "two");
    insertRun(sqlite, "f-old", "weekly-digest", "failed", NOW - 30 * HOUR, "old");

    const rows = await listCronRows(db, NOW);
    expect(rows.find((r) => r.name === "weekly-digest")?.recentFailures).toEqual([
      { id: "f1", finishedAt: new Date(NOW - 1 * HOUR), message: "one" },
      { id: "f2", finishedAt: new Date(NOW - 5 * HOUR), message: "two" },
    ]);
  });

  it("says whether a cron has ever been switched here (Recova's config row note)", async () => {
    const { db, sqlite } = createInMemoryDb();
    sqlite
      .prepare("insert into cron_config (cron_name, enabled, updated_at) values (?, ?, ?)")
      .run("weekly-digest", 0, NOW);
    const rows = await listCronRows(db, NOW);
    expect(rows.find((r) => r.name === "weekly-digest")).toMatchObject({ configured: true, enabled: false });
    expect(rows.find((r) => r.name === "d1-backup")).toMatchObject({ configured: false, enabled: true });
  });

  it("lists every registered cron, once, in the registry's order", async () => {
    const { db } = createInMemoryDb();
    expect((await listCronRows(db, NOW)).map((r) => r.name)).toEqual(CRON_JOBS.map((j) => j.name));
  });
});

// ---------------------------------------------------------------- the loader

describe("the loader", () => {
  let sqlite: Sqlite;
  beforeEach(() => {
    const made = createInMemoryDb();
    harness.db = made.db;
    sqlite = made.sqlite;
    sqlite.prepare("insert into cron_config (cron_name, enabled, updated_at) values (?, ?, ?)").run("weekly-digest", 0, NOW);
  });

  async function load(search: string) {
    expect(typeof route.loader).toBe("function");
    const context = new RouterContextProvider();
    context.set(cloudflareContext, { env: {} as Env, ctx: {} as ExecutionContext, nonce: "" });
    const loader = route.loader as (args: unknown) => Promise<Record<string, unknown>>;
    return loader({ request: new Request(`https://foxhoundapp.com/admin/platform/crons${search}`), context, params: {} });
  }

  it("opens the confirm page for a switched-off cron named in the address", async () => {
    expect((await load("?enable=weekly-digest")).confirmEnable).toBe("weekly-digest");
  });

  it("does not open it for a cron that is already on, an unknown name or no name", async () => {
    expect((await load(`?enable=${RECOVERY_TICK_CRON_NAME}`)).confirmEnable).toBeNull();
    expect((await load("?enable=no-such-cron")).confirmEnable).toBeNull();
    expect((await load("")).confirmEnable).toBeNull();
  });
});


// The page says times relative to the real clock, so its rows are too.




