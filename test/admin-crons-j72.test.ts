import { readFileSync } from "node:fs";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub, RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cronEnableConfirmPhrase } from "~/lib/admin/brake";
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
const CronsPage = route.default as (props: unknown) => React.ReactNode;

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

// ---------------------------------------------------------------- the page

interface Row {
  name: string;
  schedule: string;
  enabled: boolean;
  configured: boolean;
  minIntervalMinutes: number | null;
  lastRun: { id: string; status: string; finishedAt: Date; rowsProcessed: number | null; message: string | null } | null;
  lastSucceededAt: Date | null;
  recentFailures: Array<{ id: string; finishedAt: Date; message: string | null }>;
}

// The page says times relative to the real clock, so its rows are too.
const T = Date.now();

function row(name: string, over: Partial<Row> = {}): Row {
  return {
    name,
    schedule: "0 3 * * *",
    enabled: true,
    configured: true,
    minIntervalMinutes: null,
    lastRun: { id: `${name}-last`, status: "success", finishedAt: new Date(T - HOUR), rowsProcessed: 4, message: "4 sent" },
    lastSucceededAt: new Date(T - HOUR),
    recentFailures: [],
    ...over,
  };
}

const ROWS: Row[] = [
  row(RECOVERY_TICK_CRON_NAME, { schedule: "*/5 * * * *" }),
  row("weekly-digest", {
    schedule: "0 8 * * 1",
    enabled: false,
    lastRun: { id: "f1", status: "failed", finishedAt: new Date(T - 2 * HOUR), rowsProcessed: 0, message: "Email binding unavailable" },
    lastSucceededAt: new Date(T - 7 * DAY),
    recentFailures: [{ id: "f1", finishedAt: new Date(T - 2 * HOUR), message: "Email binding unavailable" }],
  }),
  row("d1-backup", { configured: false, lastRun: null, lastSucceededAt: null }),
];

function render(over: { crons?: Row[]; confirmEnable?: string | null; actionData?: unknown } = {}) {
  const data = { crons: over.crons ?? ROWS, confirmEnable: over.confirmEnable ?? null };
  const Stub = createRoutesStub([
    {
      path: "/admin/platform/crons",
      Component: () => createElement(CronsPage as never, { loaderData: data, actionData: over.actionData } as never),
    },
  ]);
  return renderToStaticMarkup(createElement(Stub, { initialEntries: ["/admin/platform/crons"] }));
}

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
    .replace(/\s+/g, " ");

describe("the Crons page", () => {
  it("is one captioned Capsomer table with Recova's columns in sentence case", () => {
    const html = render();
    expect(html).toMatch(/<table class="cap-table"/);
    expect(html).toMatch(/<caption[^>]*>[^<]*scheduled jobs/i);
    const headers = [...html.matchAll(/<th scope="col"[^>]*>(.*?)<\/th>/g)].map((m) => text(m[1]).trim());
    expect(headers).toEqual(["Cron", "State", "Last run", "Last succeeded", "Last message", "Change"]);
    expect(html).not.toMatch(/\buppercase\b|\btracking-/);
  });

  it("keeps each cron's anchor and its schedule in words", () => {
    const html = render();
    expect(html).toMatch(/<tr[^>]*id="cron-recovery-tick"/);
    expect(text(html)).toContain("Every 5 minutes");
    expect(text(html)).toContain("Mondays at 08:00 UTC");
  });

  it("says each last run in a word with its shape, and No runs yet for a cron that never ran", () => {
    const t = text(render());
    expect(t).toContain("Succeeded");
    expect(t).toContain("Failed");
    expect(t).toContain("No runs yet");
  });

  it("shows when a cron last succeeded, apart from its last run, and never when it has not", () => {
    const html = render();
    const digestRow = /<tr[^>]*id="cron-weekly-digest"[\s\S]*?<\/tr>/.exec(html)?.[0] ?? "";
    expect(digestRow).toContain(`dateTime="${new Date(T - 7 * DAY).toISOString()}"`);
    const backupRow = /<tr[^>]*id="cron-d1-backup"[\s\S]*?<\/tr>/.exec(html)?.[0] ?? "";
    expect(text(backupRow)).toMatch(/\bNever\b/);
  });

  it("shows the last message and says None when there is none", () => {
    const t = text(render());
    expect(t).toContain("Email binding unavailable");
    expect(t).toContain("4 sent");
    expect(t).toContain("None");
  });

  it("says On or Switched off, and On by default for a cron never switched here", () => {
    const html = render();
    const t = text(html);
    expect(t).toContain("On");
    expect(t).toContain("Switched off");
    const backupRow = /<tr[^>]*id="cron-d1-backup"[\s\S]*?<\/tr>/.exec(html)?.[0] ?? "";
    expect(text(backupRow)).toContain("On by default");
  });

  it("lists each failure of the last day under its cron, with the run's own anchor", () => {
    const html = render();
    expect(html).toMatch(/<li[^>]*id="run-f1"/);
    expect(text(html)).toContain("1 failed run in the last 24 hours");
  });

  it("disables in one click, a posted form with no phrase", () => {
    const html = render();
    const form = /<form[^>]*method="post"[^>]*>(?:(?!<\/form>)[\s\S])*name="cronName" value="recovery-tick"[\s\S]*?<\/form>/.exec(html)?.[0] ?? "";
    expect(form).toMatch(/name="nextEnabled" value="false"/);
    expect(form).not.toMatch(/name="confirm"/);
    expect(text(form)).toContain("Disable");
  });

  it("enables through a link to the confirm page, never an inline one-click button", () => {
    const html = render();
    expect(html).toMatch(/<a[^>]*href="\/admin\/platform\/crons\?enable=weekly-digest"[^>]*>[\s\S]*?Enable/);
    expect(html).not.toMatch(/name="nextEnabled" value="true"/);
  });

  it("has no Run now control (ruling 406 binding 5)", () => {
    expect(text(render())).not.toMatch(/run now/i);
  });

  it("says how many crons there are and how many are switched off, in words", () => {
    const t = text(render());
    expect(t).toContain("3 scheduled jobs, 1 switched off.");
  });

  it("has an empty state", () => {
    expect(text(render({ crons: [] }))).toContain("No scheduled jobs are registered.");
  });

  it("says what a change did", () => {
    expect(text(render({ actionData: { ok: true, cronName: "weekly-digest", enabled: false } }))).toContain(
      "weekly-digest is switched off.",
    );
    expect(text(render({ actionData: { ok: true, cronName: "weekly-digest", enabled: true } }))).toContain(
      "weekly-digest is on.",
    );
  });
});

describe("the confirm page", () => {
  const phrase = cronEnableConfirmPhrase("weekly-digest");

  it("is Capsomer's confirm page for that cron, posting the typed phrase", () => {
    const html = render({ confirmEnable: "weekly-digest" });
    expect(html).toMatch(/<form class="cap-confirm-page"[^>]*method="post"/);
    expect(html).toMatch(/action="\/admin\/platform\/crons\?enable=weekly-digest"/);
    expect(html).toMatch(/<input type="hidden" name="cronName" value="weekly-digest"/);
    expect(html).toMatch(/<input type="hidden" name="nextEnabled" value="true"/);
    const typed = /<input[^>]*name="confirm"[^>]*>/.exec(html)?.[0] ?? "";
    expect(typed).toMatch(/\brequired\b/);
    expect(text(html)).toContain(`Type ${phrase} to confirm`);
    expect(text(html)).toContain("Enable weekly-digest?");
    expect(html).toMatch(/<h2[^>]*class="cap-dialog-title"/);
    expect(html).toMatch(/<a class="cap-btn" href="\/admin\/platform\/crons#cron-weekly-digest">Cancel<\/a>/);
  });

  it("shows the server's refusal inside it", () => {
    const html = render({ confirmEnable: "weekly-digest", actionData: { error: `Type ${phrase} exactly to enable this cron.` } });
    expect(text(html)).toContain("Not done. Nothing was changed.");
    expect(text(html)).toContain(`Type ${phrase} exactly`);
  });

  it("replaces the table while it is open", () => {
    expect(render({ confirmEnable: "weekly-digest" })).not.toMatch(/<table/);
  });
});

describe("the page source", () => {
  const source = readFileSync("app/routes/admin/crons.tsx", "utf8");

  it("has no amber, no hand-sized text and no heading of its own", () => {
    expect(source).not.toMatch(/amber|orange|warning-text|tone="warn"/);
    expect(source).not.toMatch(/text-\[/);
    expect(source).not.toMatch(/<h1\b/);
  });

  it("marks its list busy while it is read again", () => {
    expect(source).toMatch(/pagePending\(/);
    expect(source).toMatch(/aria-busy=/);
  });

  it("reads through the admin data layer and never runs a cron", () => {
    expect(source).not.toMatch(/runCronJob|~\/lib\/cron\/run/);
  });
});
