import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { auditLookupIds, auditTarget, describeAuditAction } from "~/lib/admin/audit-describe";
import { cronAnchor, cronRunAnchor, cronRunHref, describeCronSchedule } from "~/lib/admin/crons";
import { listCronRows } from "~/lib/admin/crons.server";
import { getPlatformOverview } from "~/lib/admin/overview.server";
import { adminPageName } from "~/lib/admin/page";
import { CRON_JOBS } from "~/lib/cron/registry";

import { createInMemoryDb } from "./helpers/inmemory-db";

// Dustin's second review of the admin on Capsomer's AdminShell (2026-10-11,
// job_6566f4776fdf): one content frame for every page, plain-words cron
// schedules, every failed run linked and shown on its cron, and the audit log
// in plain English with real targets.

function adminRouteFiles(dir = "app/routes/admin"): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? adminRouteFiles(path) : path.endsWith(".tsx") ? [path] : [];
  });
}

describe("adminPageName", () => {
  it("takes the deepest named route, from a string or from its loader data", () => {
    expect(adminPageName([{ handle: undefined }, { handle: { page: "Crons" } }])).toBe("Crons");
    expect(
      adminPageName([
        { handle: { page: "Merchants" } },
        { handle: { page: (d: { name: string }) => d.name }, loaderData: { name: "Northwind Coffee" } },
      ]),
    ).toBe("Northwind Coffee");
    expect(adminPageName([{ handle: undefined }])).toBeNull();
  });
});

describe("describeCronSchedule", () => {
  it("says every registered schedule in words", () => {
    for (const job of CRON_JOBS) {
      expect(describeCronSchedule(job.schedule), `${job.name}: ${job.schedule}`).not.toBeNull();
    }
  });

  it("names the interval, the day and the UTC time", () => {
    expect(describeCronSchedule("*/5 * * * *")).toBe("Every 5 minutes");
    expect(describeCronSchedule("*/1 * * * *")).toBe("Every minute");
    expect(describeCronSchedule("0 3 * * *")).toBe("Daily at 03:00 UTC");
    expect(describeCronSchedule("30 14 * * *")).toBe("Daily at 14:30 UTC");
    expect(describeCronSchedule("0 8 * * 1")).toBe("Mondays at 08:00 UTC");
    expect(describeCronSchedule("0 8 * * 0")).toBe("Sundays at 08:00 UTC");
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
  const NOW = Date.UTC(2026, 9, 11, 18, 0, 0);
  const HOUR = 60 * 60 * 1000;

  function seed(now = NOW) {
    const { db, sqlite } = createInMemoryDb();
    const run = (id: string, cronName: string, status: string, hoursAgo: number, message: string | null = null) =>
      sqlite
        .prepare(
          "insert into cron_run_history (id, cron_name, started_at, finished_at, status, rows_processed, message, created_at) values (?, ?, ?, ?, ?, 0, ?, ?)",
        )
        .run(id, cronName, now - hoursAgo * HOUR - 1000, now - hoursAgo * HOUR, status, message, now - hoursAgo * HOUR);
    run("r-ok", "weekly-digest", "success", 1);
    run("r-fail", "weekly-digest", "failed", 5, "Email binding unavailable");
    run("r-old", "weekly-digest", "failed", 30, "too old to count");
    run("r-tick", "recovery-tick", "success", 0.2);
    return db;
  }

  it("the Crons page puts the failure on that cron, with the run's own anchor", async () => {
    const rows = await listCronRows(seed(), NOW);
    const digest = rows.find((r) => r.name === "weekly-digest");
    expect(digest?.lastRun?.status).toBe("success");
    expect(digest?.recentFailures).toEqual([
      { id: "r-fail", finishedAt: new Date(NOW - 5 * HOUR), message: "Email binding unavailable" },
    ]);
    expect(rows.find((r) => r.name === "recovery-tick")?.recentFailures).toEqual([]);
  });

  it("the Overview counts the same run and links to that anchor", async () => {
    // getPlatformOverview reads its 24-hour window from the real clock, so this
    // seed is relative to it.
    const overview = await getPlatformOverview(seed(Date.now()));
    expect(overview.cronHealth.failedLast24h).toBe(1);
    expect(overview.cronHealth.failedRuns.map((r) => [r.id, r.cronName, r.message])).toEqual([
      ["r-fail", "weekly-digest", "Email binding unavailable"],
    ]);
    expect(cronRunHref("r-fail")).toBe(`/admin/platform/crons#${cronRunAnchor("r-fail")}`);
    expect(cronAnchor("weekly-digest")).toBe("cron-weekly-digest");
  });
});

describe("the audit log in plain English", () => {
  it("says every action the admin writes as a sentence", () => {
    const written = new Set<string>();
    const sources = [
      ...adminRouteFiles(),
      "app/lib/admin/brake.server.ts",
      "app/lib/admin/staged.server.ts",
      "app/lib/billing/adjustment.ts",
      "app/lib/admin-api/handler.server.ts",
    ];
    for (const file of sources) {
      const source = readFileSync(file, "utf8");
      for (const m of source.matchAll(/"((?:cron|brake|merchant|billing|blog|staged)\.[a-z_.-]+)"/g)) written.add(m[1]);
    }
    expect(written.size).toBeGreaterThan(15);
    for (const action of written) {
      expect(describeAuditAction(action), action).not.toBe(action);
    }
    expect(describeAuditAction("cron.disable")).toBe("Disabled a cron");
  });

  it("shows an unknown action as written rather than hiding it", () => {
    expect(describeAuditAction("something.new")).toBe("something.new");
  });

  const lookups = {
    merchantNames: new Map([["acct_b", "Northwind Coffee"]]),
    postTitles: new Map([["post_1", "Why cards fail"]]),
  };
  const entry = (action: string, metadata: unknown, targetEmail: string | null = null) => ({
    action,
    metadata,
    targetEmail,
    targetUserId: null,
  });

  it("names real targets, never raw JSON", () => {
    expect(auditTarget(entry("cron.disable", { cronName: "recovery-tick" }), lookups)).toEqual({
      label: "recovery-tick",
      href: "/admin/platform/crons#cron-recovery-tick",
    });
    expect(auditTarget(entry("merchant.cancel", { accountId: "acct_b", deauthorizeErrors: [] }), lookups)).toEqual({
      label: "Northwind Coffee",
      href: "/admin/merchants/acct_b",
    });
    expect(auditTarget(entry("merchant.cancel", { accountId: "acct_gone" }), lookups)?.label).toBe("acct_gone");
    expect(auditTarget(entry("blog.publish", { postId: "post_1", slug: "why" }), lookups)).toEqual({
      label: "Why cards fail",
      href: "/admin/blog/post_1",
    });
    expect(auditTarget(entry("brake.engage", { intendedCount: 3, sample: ["a"] }), lookups)).toEqual({
      label: "All merchants (3)",
      href: "/admin/brake",
    });
    expect(auditTarget(entry("staged.confirm", { stagedId: "s1", summary: "Resume processing for acct_b" }), lookups)).toEqual({
      label: "Resume processing for acct_b",
      href: "/admin/staged",
    });
    expect(auditTarget(entry("something.new", { anything: 1 }), lookups)).toBeNull();
    expect(auditTarget(entry("something.new", null, "a@b.c"), lookups)).toEqual({ label: "a@b.c" });
  });

  it("collects the ids the loader looks names up for", () => {
    expect(
      auditLookupIds([
        entry("merchant.cancel", { accountId: "acct_b" }),
        entry("blog.update", { postId: "post_1" }),
        entry("merchant.cancel", { accountId: "acct_b" }),
        entry("cron.disable", { cronName: "x" }),
      ]),
    ).toEqual({ accountIds: ["acct_b"], postIds: ["post_1"] });
  });
});
