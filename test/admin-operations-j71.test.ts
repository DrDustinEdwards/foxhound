import { readFileSync } from "node:fs";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub, RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cloudflareContext } from "~/lib/cloudflare-context";
import { CRON_JOBS } from "~/lib/cron/registry";

import { createInMemoryDb } from "./helpers/inmemory-db";

// J71 (job_77e09916862e): /admin/operations on the family admin pattern
// (Capsomer's parts, Dustin's Q9 of 2026-10-14) and his 2026-10-11 review.
// Recova's page (app/admin/operations/OperationsClient.tsx, blob 419a51ac) is
// the inventory: the global pause (which is /admin/brake here and is not
// repeated), a queue-depth card ("Payments in active recovery queue"), a
// cron-lock health table (Idle, Running, Stale), a run-now panel (ruling 406
// binding 5 keeps it out) and a Vercel redeploy hook (no Cloudflare
// counterpart). Foxhound's own four panels stay: database size, table growth,
// migrations and settings.

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

// Looked up so a missing module or export fails the assertion that names it,
// not the whole file (RULES.md 6.5).
const route: Record<string, unknown> = await import("~/routes/admin/operations").catch(() => ({}));
const lib: Record<string, unknown> = await import("~/lib/admin/operations.server").catch(() => ({}));
const lockState: Record<string, unknown> = await import("~/lib/cron/lock-state").catch(() => ({}));

const NOW = Date.UTC(2026, 9, 15, 18, 0, 0);
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

type Sqlite = ReturnType<typeof createInMemoryDb>["sqlite"];

// ------------------------------------------------------------ the lock's view

describe("the cron lock's read-only view", () => {
  it("leaves the holder's token out, since the token is the fence", () => {
    const view = lockState.cronLockView as (s: unknown) => Record<string, unknown>;
    expect(typeof view).toBe("function");
    const v = view({ lock: { heldUntil: NOW + MIN, token: "secret-token" }, legacyHeldUntil: null });
    expect(v).toEqual({ heldUntil: NOW + MIN, legacyHeldUntil: null });
    expect(JSON.stringify(v)).not.toContain("secret-token");
  });

  it("says idle with no record, running while the lease holds, and not released after it ran out", () => {
    const health = lockState.cronLockHealth as (v: unknown, now: number) => Record<string, unknown>;
    expect(typeof health).toBe("function");
    expect(health({ heldUntil: null, legacyHeldUntil: null }, NOW)).toEqual({ state: "idle", heldUntil: null });
    expect(health({ heldUntil: NOW + 5 * MIN, legacyHeldUntil: null }, NOW)).toEqual({
      state: "running",
      heldUntil: NOW + 5 * MIN,
    });
    // A lease that ran out and was never released: the run stopped without its
    // release, or is still going past its lease. The next run takes it anyway.
    expect(health({ heldUntil: NOW - 5 * MIN, legacyHeldUntil: null }, NOW)).toEqual({
      state: "not-released",
      heldUntil: NOW - 5 * MIN,
    });
    // Exactly now is expired, the boundary decideAcquire uses.
    expect(health({ heldUntil: NOW, legacyHeldUntil: null }, NOW).state).toBe("not-released");
  });

  it("reads the pre-fence key too, the later of the two winning", () => {
    const health = lockState.cronLockHealth as (v: unknown, now: number) => Record<string, unknown>;
    expect(health({ heldUntil: null, legacyHeldUntil: NOW + MIN }, NOW)).toEqual({ state: "running", heldUntil: NOW + MIN });
    expect(health({ heldUntil: NOW - MIN, legacyHeldUntil: NOW + 2 * MIN }, NOW).state).toBe("running");
  });

  it("is a read on the Durable Object that writes nothing", () => {
    const source = readFileSync("workers/cron-lock.ts", "utf8");
    const peek = /async peek\(\)[\s\S]*?\n {2}\}/.exec(source)?.[0] ?? "";
    expect(peek).toMatch(/cronLockView\(await this\.readState\(\)\)/);
    expect(peek).not.toMatch(/storage\.(put|delete)/);
  });
});

// --------------------------------------------------------- reading the locks

function lockNamespace(views: Record<string, unknown>, failing: string[] = []) {
  const asked: string[] = [];
  return {
    asked,
    ns: {
      idFromName: (name: string) => ({ name }),
      get: (id: { name: string }) => ({
        peek: async () => {
          asked.push(id.name);
          if (failing.includes(id.name)) throw new Error("Durable Object unavailable");
          return views[id.name] ?? { heldUntil: null, legacyHeldUntil: null };
        },
      }),
    },
  };
}

describe("readCronLocks", () => {
  it("reads every registered cron's lock, in the registry's order", async () => {
    const read = lib.readCronLocks as (env: unknown, now: number) => Promise<Array<Record<string, unknown>>>;
    expect(typeof read).toBe("function");
    const { ns, asked } = lockNamespace({
      "recovery-tick": { heldUntil: NOW + 3 * MIN, legacyHeldUntil: null },
      "weekly-digest": { heldUntil: NOW - HOUR, legacyHeldUntil: null },
    });
    const locks = await read({ CRON_LOCK: ns }, NOW);
    expect(locks.map((l) => l.name)).toEqual(CRON_JOBS.map((j) => j.name));
    expect(asked.sort()).toEqual(CRON_JOBS.map((j) => j.name).sort());
    expect(locks.find((l) => l.name === "recovery-tick")).toEqual({
      name: "recovery-tick",
      state: "running",
      heldUntil: new Date(NOW + 3 * MIN),
    });
    expect(locks.find((l) => l.name === "weekly-digest")).toMatchObject({ state: "not-released" });
    expect(locks.find((l) => l.name === "d1-backup")).toEqual({ name: "d1-backup", state: "idle", heldUntil: null });
  });

  it("says a lock could not be read rather than failing the page", async () => {
    const read = lib.readCronLocks as (env: unknown, now: number) => Promise<Array<Record<string, unknown>>>;
    const { ns } = lockNamespace({}, ["d1-backup"]);
    const locks = await read({ CRON_LOCK: ns }, NOW);
    expect(locks.find((l) => l.name === "d1-backup")).toEqual({
      name: "d1-backup",
      state: "unreadable",
      heldUntil: null,
    });
    expect(locks.filter((l) => l.state === "unreadable")).toHaveLength(1);
  });
});

// ------------------------------------------------------ the recovery queue

function seedQueue(sqlite: Sqlite) {
  const account = (id: string, paused = 0, cancelled: number | null = null) =>
    sqlite
      .prepare("insert into accounts (id, name, processing_paused, cancelled_at) values (?, ?, ?, ?)")
      .run(id, id, paused, cancelled);
  account("acc_live");
  account("acc_paused", 1);
  account("demo_acc", 0);
  const payment = (id: string, accountId: string, status: string) =>
    sqlite
      .prepare(
        "insert into failed_payments (id, account_id, stripe_event_id, stripe_invoice_id, stripe_customer_id, customer_email, amount_cents, currency, decline_category, status, detected_at) values (?, ?, ?, ?, 'c', 'x@example.com', 4200, 'usd', 'soft', ?, 0)",
      )
      .run(id, accountId, `e_${id}`, `i_${id}`, status);
  payment("fp_1", "acc_live", "active");
  payment("fp_2", "acc_live", "active");
  payment("fp_3", "acc_live", "recovered");
  payment("fp_4", "acc_paused", "active");
  payment("fp_demo", "demo_acc", "active");
  const step = (id: string, fp: string, accountId: string, scheduledAt: number, over: { nextRetryAt?: number; executedAt?: number } = {}) =>
    sqlite
      .prepare(
        "insert into recovery_steps (id, failed_payment_id, step_type, scheduled_at, account_id, next_retry_at, executed_at) values (?, ?, 'email', ?, ?, ?, ?)",
      )
      .run(id, fp, scheduledAt, accountId, over.nextRetryAt ?? null, over.executedAt ?? null);
  step("s_due_old", "fp_1", "acc_live", NOW - 40 * MIN);
  step("s_due_new", "fp_2", "acc_live", NOW - 2 * MIN);
  // Rescheduled by a send backoff to later: not due, though scheduled long ago.
  step("s_backoff", "fp_2", "acc_live", NOW - 3 * HOUR, { nextRetryAt: NOW + 10 * MIN });
  // Rescheduled to a time that has come: due, and the oldest of all.
  step("s_retry_due", "fp_1", "acc_live", NOW - 5 * HOUR, { nextRetryAt: NOW - 50 * MIN });
  step("s_future", "fp_1", "acc_live", NOW + HOUR);
  step("s_done", "fp_1", "acc_live", NOW - HOUR, { executedAt: NOW - HOUR });
  step("s_recovered", "fp_3", "acc_live", NOW - HOUR);
  step("s_paused", "fp_4", "acc_paused", NOW - HOUR);
  step("s_demo", "fp_demo", "demo_acc", NOW - HOUR);
}

describe("getRecoveryQueueDepth", () => {
  it("counts payments in recovery as the Overview does, and the steps the tick would run now", async () => {
    const depth = lib.getRecoveryQueueDepth as (db: unknown, now: number) => Promise<Record<string, unknown>>;
    expect(typeof depth).toBe("function");
    const { db, sqlite } = createInMemoryDb();
    seedQueue(sqlite);
    const result = await depth(db, NOW);
    // fp_1, fp_2 and the paused account's fp_4; never the demo account's.
    expect(result.activePayments).toBe(3);
    // s_due_old, s_due_new and s_retry_due: the paused, demo, recovered, done,
    // future and backed-off steps are not the tick's to run.
    expect(result.dueSteps).toBe(3);
    expect(result.oldestDueAt).toEqual(new Date(NOW - 50 * MIN));
  });

  it("is empty on an empty database", async () => {
    const depth = lib.getRecoveryQueueDepth as (db: unknown, now: number) => Promise<Record<string, unknown>>;
    const { db } = createInMemoryDb();
    expect(await depth(db, NOW)).toEqual({ activePayments: 0, dueSteps: 0, oldestDueAt: null });
  });
});

// ---------------------------------------------------------------- the loader

describe("the loader", () => {
  beforeEach(() => {
    const made = createInMemoryDb();
    harness.db = made.db;
    seedQueue(made.sqlite);
  });

  it("reads the queue and the locks with Foxhound's own engine", async () => {
    expect(typeof route.loader).toBe("function");
    const { ns } = lockNamespace({ "recovery-tick": { heldUntil: Date.now() + 5 * MIN, legacyHeldUntil: null } });
    const env = {
      CRON_LOCK: ns,
      DB: {
        prepare: (sql: string) => ({
          run: async () => ({ meta: { size_after: 4096 } }),
          all: async () => ({ results: sql.includes("d1_migrations") ? [] : [] }),
        }),
      },
    };
    const context = new RouterContextProvider();
    context.set(cloudflareContext, { env: env as unknown as Env, ctx: {} as ExecutionContext, nonce: "" });
    const loader = route.loader as (args: unknown) => Promise<Record<string, unknown>>;
    const data = await loader({ request: new Request("https://foxhoundapp.com/admin/operations"), context, params: {} });
    expect(data.queue).toMatchObject({ activePayments: 3 });
    const locks = data.locks as Array<Record<string, unknown>>;
    expect(locks).toHaveLength(CRON_JOBS.length);
    expect(locks.find((l) => l.name === "recovery-tick")?.state).toBe("running");
    expect(data.sizeBytes).toBe(4096);
  });
});

// ---------------------------------------------------------------- the page

type Lock = { name: string; state: string; heldUntil: Date | null };
const T = Date.now();

function loaderData(over: Record<string, unknown> = {}) {
  return {
    sizeBytes: 900 * 1024,
    queue: { activePayments: 12, dueSteps: 3, oldestDueAt: new Date(T - 4 * MIN) },
    locks: [
      { name: "recovery-tick", state: "running", heldUntil: new Date(T + 12 * MIN) },
      { name: "weekly-digest", state: "not-released", heldUntil: new Date(T - 2 * HOUR) },
      { name: "d1-backup", state: "idle", heldUntil: null },
      { name: "cron-health", state: "unreadable", heldUntil: null },
    ] as Lock[],
    growthTables: [{ label: "Email sends", retentionPolicy: "180 days", rowCount: 1234 }],
    migrations: {
      rows: [
        { name: "0000_init.sql", applied: true, appliedAt: new Date(T - 30 * 24 * HOUR) },
        { name: "0029_cron_reads.sql", applied: false, appliedAt: null },
      ],
      unexpectedApplied: [],
    },
    envSanity: [
      { name: "DB", kind: "binding", set: true },
      { name: "SENTRY_AUTH_TOKEN", kind: "secret", set: false },
      { name: "SENTRY_ORG", kind: "secret", set: true },
      { name: "AI_GATEWAY_BASE_URL", kind: "var", set: false },
    ],
    ...over,
  };
}

function render(data: Record<string, unknown> = loaderData()) {
  const Page = route.default as unknown;
  expect(typeof Page).toBe("function");
  const Stub = createRoutesStub([
    { path: "/admin/operations", Component: () => createElement(Page as never, { loaderData: data } as never) },
  ]);
  return renderToStaticMarkup(createElement(Stub, { initialEntries: ["/admin/operations"] }));
}

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
    .replace(/\s+/g, " ");

const panelTitles = (html: string) => [...html.matchAll(/<h2[^>]*>(.*?)<\/h2>/g)].map((m) => text(m[1]).trim());

describe("the Operations page", () => {
  it("is Capsomer panels in sentence case, queue and locks first, Foxhound's four after", () => {
    const html = render();
    expect(panelTitles(html)).toEqual([
      "Recovery queue",
      "Cron locks",
      "Database size",
      "Table growth",
      "Migrations",
      "Settings",
    ]);
    expect(html).toMatch(/class="cap-panel/);
    expect(html).not.toMatch(/\buppercase\b|\btracking-/);
  });

  it("shows the queue's depth in plain words", () => {
    const t = text(render());
    expect(t).toContain("Payments in recovery");
    expect(t).toContain("12");
    expect(t).toContain("Steps due now");
    expect(t).toMatch(/Oldest due 4 minutes ago/);
  });

  it("says the queue is empty in words", () => {
    const t = text(render(loaderData({ queue: { activePayments: 0, dueSteps: 0, oldestDueAt: null } })));
    expect(t).toContain("No step is waiting for the recovery tick.");
  });

  it("is one captioned table of cron locks with a word, a glyph and a time each", () => {
    const html = render();
    expect(html).toMatch(/<caption[^>]*>[^<]*cron locks/i);
    const t = text(html);
    expect(t).toContain("Running");
    expect(t).toContain("Not released");
    expect(t).toContain("Idle");
    expect(t).toContain("Could not read");
    expect(html).toContain(`dateTime="${new Date(T + 12 * MIN).toISOString()}"`);
    expect(t).toContain("1 cron lock held, 1 not released.");
  });

  it("has an empty state for the locks", () => {
    expect(text(render(loaderData({ locks: [] })))).toContain("No crons are registered, so there are no locks to read.");
  });

  it("draws the database size as a meter with its number in text, and no amber over half", () => {
    const html = render();
    expect(html).toMatch(/role="meter"/);
    expect(text(html)).toContain("900 KB of 10 GB");
    const full = render(loaderData({ sizeBytes: 6 * 1024 * 1024 * 1024 }));
    expect(text(full)).toContain("Over half full");
    expect(full).not.toMatch(/data-tone="warn"/);
  });

  it("keeps the table growth, migrations and settings Foxhound has today", () => {
    const t = text(render());
    expect(t).toContain("Email sends");
    expect(t).toContain("1,234");
    expect(t).toContain("0029_cron_reads.sql");
    expect(t).toContain("Not applied");
    expect(t).toContain("SENTRY_AUTH_TOKEN");
    expect(t).toContain("SENTRY_ORG");
    expect(t).toContain("Not set");
    expect(t).toContain("Secret");
    expect(t).toContain("Variable");
  });

  it("has an empty state for the migrations", () => {
    expect(text(render(loaderData({ migrations: { rows: [], unexpectedApplied: [] } })))).toContain(
      "No migrations are recorded in this build.",
    );
  });

  it("repeats neither the brake nor the crons page, and has no run-now or redeploy", () => {
    const html = render();
    const t = text(html);
    expect(t).not.toMatch(/pause all|emergency brake|resume all|run now|redeploy|vercel/i);
    expect(html).not.toMatch(/href="\/admin\/(brake|platform\/crons)/);
    expect(t).not.toMatch(/Last succeeded|Last message/);
  });
});

describe("the page source", () => {
  const source = (() => {
    try {
      return readFileSync("app/routes/admin/operations.tsx", "utf8");
    } catch {
      return "";
    }
  })();

  it("names itself once for the top bar", () => {
    expect(source).toMatch(/export const handle: AdminHandle = \{ page: "Operations" \}/);
    expect(source).not.toMatch(/<h1\b/);
  });

  it("has no amber and no hand-sized text", () => {
    expect(source).toMatch(/\S/);
    expect(source).not.toMatch(/amber|orange|warning-text|tone="warn"|text-\[/);
  });

  it("marks its lists busy while they are read again", () => {
    expect(source).toMatch(/pagePending\(/);
    expect(source).toMatch(/aria-busy=/);
  });

  it("keeps the settings list's read settings for the Errors page", async () => {
    const getEnvSanity = lib.getEnvSanity as (env: unknown) => Array<{ name: string }>;
    const names = getEnvSanity({}).map((r) => r.name);
    expect(names).toContain("SENTRY_AUTH_TOKEN");
    expect(names).toContain("SENTRY_ORG");
  });
});
