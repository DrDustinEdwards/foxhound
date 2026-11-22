import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  cronAnchor,
  cronRunAnchor,
  cronRunHref,
  cronRunId,
  describeCronSchedule,
} from "~/lib/admin/crons";
import { listCronRows, setCronEnabled } from "~/lib/admin/crons.server";
import { cronEnableConfirmPhrase, isCronEnableConfirmValid } from "~/lib/admin/brake";
import { adminContext } from "~/lib/admin/context";
import * as schema from "~/db/schema";
import { isCronEnabled } from "~/lib/cron/gating";
import { CRON_JOBS } from "~/lib/cron/registry";
import { getPlatformOverview } from "~/lib/admin/overview.server";
import * as route from "~/routes/admin/crons";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import { accounts, cronConfig } from "~/db";
import { RECOVERY_TICK_CRON_NAME } from "~/lib/constants";

import { createInMemoryDb } from "./helpers/inmemory-db";

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const NOW = Date.UTC(2026, 9, 15, 18, 0, 0);
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

type Sqlite = ReturnType<typeof createInMemoryDb>["sqlite"];

/** One run as runJobs writes it: its cron_run_log row and its cron_runs record. */
function insertRun(
  sqlite: Sqlite,
  cronName: string,
  outcome: "ok" | "failed",
  at: number,
  reason = "",
) {
  sqlite
    .prepare(
      "insert into cron_run_log (name, started_at, finished_at, outcome, reason) values (?, ?, ?, ?, ?)",
    )
    .run(cronName, at - 1000, at, outcome, reason);
  sqlite
    .prepare(
      `insert into cron_runs (name, every_minutes, ${outcome === "ok" ? "last_ok_at" : "last_failed_at"}) values (?, 1440, ?)
       on conflict (name) do update set ${outcome === "ok" ? "last_ok_at" : "last_failed_at"} = excluded.${outcome === "ok" ? "last_ok_at" : "last_failed_at"}`,
    )
    .run(cronName, at);
}

describe("listCronRows reads each cron's own runs", () => {
  it("says when each cron last succeeded, apart from its last run", async () => {
    const { db, sqlite } = createInMemoryDb();
    insertRun(sqlite, "weekly-digest", "ok", NOW - 8 * DAY);
    insertRun(sqlite, "weekly-digest", "ok", NOW - 7 * DAY);
    insertRun(sqlite, "weekly-digest", "failed", NOW - 2 * HOUR, "Email binding unavailable");
    insertRun(sqlite, "d1-backup", "failed", NOW - 3 * HOUR, "R2 down");

    const rows = await listCronRows(db, NOW);
    const digest = rows.find((r) => r.name === "weekly-digest");
    expect(digest?.lastRun).toMatchObject({
      status: "failed",
      message: "Email binding unavailable",
    });
    expect(digest?.lastSucceededAt).toEqual(new Date(NOW - 7 * DAY));
    expect(rows.find((r) => r.name === "d1-backup")?.lastSucceededAt).toBeNull();
    expect(rows.find((r) => r.name === "expiring-cards")?.lastSucceededAt).toBeNull();
  });

  it("says whether a cron has ever been switched here", async () => {
    const { db, sqlite } = createInMemoryDb();
    sqlite
      .prepare("insert into cron_config (cron_name, enabled, updated_at) values (?, ?, ?)")
      .run("weekly-digest", 0, NOW);
    const rows = await listCronRows(db, NOW);
    expect(rows.find((r) => r.name === "weekly-digest")).toMatchObject({
      configured: true,
      enabled: false,
    });
    expect(rows.find((r) => r.name === "d1-backup")).toMatchObject({
      configured: false,
      enabled: true,
    });
  });
});

describe("the loader", () => {
  let sqlite: Sqlite;
  beforeEach(() => {
    const made = createInMemoryDb();
    harness.db = made.db;
    sqlite = made.sqlite;
    sqlite
      .prepare("insert into cron_config (cron_name, enabled, updated_at) values (?, ?, ?)")
      .run("weekly-digest", 0, NOW);
  });

  async function load(search: string) {
    const context = new RouterContextProvider();
    context.set(cloudflareContext, { env: {} as Env, ctx: {} as ExecutionContext });
    const loader = route.loader as (args: unknown) => Promise<Record<string, unknown>>;
    return loader({
      request: new Request(`https://foxhoundapp.com/admin/platform/crons${search}`),
      context,
      params: {},
    });
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

describe("describeCronSchedule", () => {
  it("names the interval, the day and the UTC time", () => {
    expect(describeCronSchedule("*/5 * * * *")).toBe("Every 5 minutes");
    expect(describeCronSchedule("*/1 * * * *")).toBe("Every minute");
    expect(describeCronSchedule("0 3 * * *")).toBe("Daily at 03:00 UTC");
    expect(describeCronSchedule("30 14 * * *")).toBe("Daily at 14:30 UTC");
    expect(describeCronSchedule("0 8 * * MON")).toBe("Mondays at 08:00 UTC");
    // Cloudflare numbers weekdays 1 = Sunday, so a bare 1 is a Sunday run.
    expect(describeCronSchedule("0 8 * * 1")).toBe("Sundays at 08:00 UTC");
    expect(describeCronSchedule("0 4 1 * *")).toBe("Monthly on the 1st at 04:00 UTC");
    expect(describeCronSchedule("0 9 22 * *")).toBe("Monthly on the 22nd at 09:00 UTC");
    expect(describeCronSchedule("0 9 13 * *")).toBe("Monthly on the 13th at 09:00 UTC");
  });

  it("does not guess at a shape it does not know", () => {
    expect(describeCronSchedule("0 3 * 6 *")).toBeNull();
    expect(describeCronSchedule("0 3,15 * * *")).toBeNull();
    expect(describeCronSchedule("not a cron")).toBeNull();
  });
});

describe("a failed run is linked from the Overview and shown on its cron", () => {
  function seed(now = NOW) {
    const { db, sqlite } = createInMemoryDb();
    // Oldest first, as runJobs appends them.
    const run = (cronName: string, outcome: string, hoursAgo: number, reason = "") =>
      sqlite
        .prepare(
          "insert into cron_run_log (name, started_at, finished_at, outcome, reason) values (?, ?, ?, ?, ?)",
        )
        .run(cronName, now - hoursAgo * HOUR - 1000, now - hoursAgo * HOUR, outcome, reason);
    run("weekly-digest", "failed", 30, "too old to count");
    run("weekly-digest", "failed", 5, "Email binding unavailable");
    run("weekly-digest", "ok", 1);
    run("recovery-tick", "ok", 0.2);
    return db;
  }
  const failedId = (now: number) => cronRunId("weekly-digest", now - 5 * HOUR - 1000);

  it("the Crons page puts the failure on that cron, with the run's own anchor", async () => {
    const rows = await listCronRows(seed(), NOW);
    const digest = rows.find((r) => r.name === "weekly-digest");
    expect(digest?.lastRun?.status).toBe("ok");
    expect(digest?.recentFailures).toEqual([
      {
        id: failedId(NOW),
        finishedAt: new Date(NOW - 5 * HOUR),
        message: "Email binding unavailable",
      },
    ]);
    expect(rows.find((r) => r.name === "recovery-tick")?.recentFailures).toEqual([]);
  });

  it("the Overview counts the same run and links to that anchor", async () => {
    // getPlatformOverview reads its 24-hour window from the real clock, so this
    // seed is relative to it.
    const now = Date.now();
    const overview = await getPlatformOverview(seed(now));
    expect(overview.cronHealth.failedLast24h).toBe(1);
    expect(overview.cronHealth.failedRuns.map((r) => [r.id, r.cronName, r.message])).toEqual([
      [failedId(now), "weekly-digest", "Email binding unavailable"],
    ]);
    expect(cronRunHref(failedId(now))).toBe(
      `/admin/platform/crons#${cronRunAnchor(failedId(now))}`,
    );
    expect(cronAnchor("weekly-digest")).toBe("cron-weekly-digest");
  });
});

// Enable is gated on typing the exact phrase for every registered cron (billing-monthly
// moves money on its first run); disable is one click for every one of them.

const ACTOR = "admin@foxhoundapp.com";

/** The two context keys the action reads, and nothing else. */
const fakeContext = {
  get(key: unknown) {
    if (key === cloudflareContext) return { env: {} as Env, ctx: {} as ExecutionContext };
    if (key === adminContext) return { email: ACTOR };
    throw new Error("unexpected context key");
  },
} as unknown as Parameters<typeof route.action>[0]["context"];

function post(fields: Record<string, string>) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.append(k, v);
  return new Request("http://localhost/admin/crons", { method: "POST", body });
}

async function run(fields: Record<string, string>) {
  const { db } = createInMemoryDb();
  harness.db = db;
  const result = await route.action({
    context: fakeContext,
    request: post(fields),
    params: {},
  } as never);
  return {
    db,
    result: result as unknown as { data: { error?: string; ok?: boolean }; init?: ResponseInit },
  };
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
});
