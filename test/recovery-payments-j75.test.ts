import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { accounts, failedPayments, recoverySteps } from "~/db/schema";
import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";

import { createInMemoryDb, runStatement } from "./helpers/inmemory-db";

// J75 (job_16d5559b7974), row S6: /recovery/payments is Recova's page
// (app/(app)/recovery/payments/page.tsx bab8d48d, PaymentsClient.tsx 94043896,
// components/PaymentsHeader.tsx 27cd8e4a, PaymentsStats.tsx b386c660,
// PaymentsFilters.tsx b6612faf, PaymentsTable.tsx 95a10450, BulkActionBar.tsx
// 7f40166f, components/recovery/PaymentRow.tsx 0d2e1f52,
// components/AmountRangeSlider.tsx d6bb58e8 and lib/payments-data.ts 14e0a6a3,
// each read whole) built from Capsomer 0.9.0's parts (Q10), teal throughout
// (Q11), on Foxhound's engine. The approved differences it keeps are named
// where they are tested. Every assertion here was seen failing first.

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const route = await import("~/routes/app/recovery/payments/index");
const exportRoute = await import("~/routes/app/recovery/payments/export");
const Page = route.default as unknown as (props: Record<string, unknown>) => ReturnType<typeof createElement>;

const NOW = Date.parse("2026-10-16T12:00:00.000Z");
const DAY = 86_400_000;

// ---- Fixtures ----

type LoaderData = Awaited<ReturnType<typeof route.loader>>;
type Row = LoaderData["result"]["payments"][number];

function row(over: Partial<Row> = {}): Row {
  return {
    id: "fp_1",
    customerName: "Jordan Lee",
    customerEmail: "jordan@example.com",
    planName: "Growth",
    amountCents: 4999,
    currency: "usd",
    declineCategory: "soft",
    declineCode: "insufficient_funds",
    status: "active",
    detectedAt: new Date(NOW - 3 * DAY),
    hasNote: false,
    priorFailures: 0,
    steps: { completed: 1, total: 4, next: "Day 3 email" },
    ...over,
  } as Row;
}

function data(over: Partial<LoaderData> = {}): LoaderData {
  const payments = [row()];
  return {
    result: { payments, totalCount: 1, page: 1, totalPages: 1, pageSize: 25 },
    globalCounts: { all: 4, active: 1, recovered: 1, failedUnrecovered: 1, cancelled: 1 },
    globalRecoveryRatePct: 25,
    pillCounts: { all: 4, active: 1, recovered: 1, failedUnrecovered: 1, cancelled: 1 },
    header: { atRisk: [{ currency: "usd", cents: 4999 }], recovered: [], ratePct: 0 },
    bounds: { minCents: 0, maxCents: 100_000 },
    nowMs: NOW,
    filters: {
      search: "",
      status: "",
      declineCategory: "",
      time: "all",
      sort: "newest",
      pageSize: 25,
      amountMinCents: 0,
      amountMaxCents: 100_000,
    },
    ...over,
  } as LoaderData;
}

function render(loaderData: LoaderData, actionData?: unknown): string {
  try {
    const Stub = createRoutesStub([
      {
        path: "/recovery/payments",
        Component: () => createElement(Page, { loaderData, actionData }),
      },
    ]);
    return renderToStaticMarkup(createElement(Stub, { initialEntries: ["/recovery/payments"] }));
  } catch (err) {
    return `render failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}


// ---- The head ----

describe("J75: Recova's head", () => {

  it("never adds two currencies together (RULES.md 3.20)", () => {
    const html = render(
      data({
        header: {
          atRisk: [
            { currency: "usd", cents: 2_000 },
            { currency: "eur", cents: 1_000 },
          ],
          recovered: [],
          ratePct: 0,
        },
      }),
    );
    expect(text(html)).toContain("$20 · €10 at risk");
  });

  it("points Export CSV at the rows on screen: this page and this page size, as Recova exports its filtered rows", () => {
    const html = render(
      data({ result: { payments: [row()], totalCount: 60, page: 2, totalPages: 3, pageSize: 25 } } as Partial<LoaderData>),
    );
    const href = /href="(\/recovery\/payments\/export\.csv[^"]*)"/.exec(html)?.[1]?.replace(/&amp;/g, "&") ?? "";
    const qs = new URL(`https://x.test${href}`).searchParams;
    expect(qs.get("page")).toBe("2");
    expect(qs.get("perPage")).toBe("25");
  });
});

// ---- Rows per page ----

describe("J75: Recova's rows-per-page links, defaulting to 25", () => {

  it("defaults to 25 in the loader", async () => {
    const { sqlite, db } = createInMemoryDb();
    harness.db = db;
    runStatement(sqlite, db.insert(accounts).values({ id: A, name: "Alpha" }));
    const out = await load("/recovery/payments");
    expect(out.filters.pageSize).toBe(25);
  });
});

// ---- The loader, against an in-memory database ----

const A = "acct_alpha";
const B = "acct_beta";

function contextFor(accountId: string): unknown {
  return {
    get(key: unknown) {
      if (key === cloudflareContext) {
        return { env: {} as Env, ctx: { waitUntil() {} } as unknown as ExecutionContext, nonce: "n" };
      }
      if (key === authContext) {
        return {
          userId: "u",
          userName: "u",
          email: "owner@alpha.test",
          membership: { memberId: "m", accountId, accountName: "Alpha", role: "owner" },
          memberships: [],
          activeAccountId: accountId,
          isAdmin: false,
          isDemo: false,
          demoSignedIn: false,
        };
      }
      throw new Error("unexpected context key");
    },
  };
}

async function load(path: string, accountId = A): Promise<LoaderData> {
  return (await route.loader({
    context: contextFor(accountId),
    request: new Request(`https://foxhoundapp.test${path}`),
    params: {},
  } as never)) as LoaderData;
}

let seq = 0;
function seed(
  sqlite: ReturnType<typeof createInMemoryDb>["sqlite"],
  db: ReturnType<typeof createInMemoryDb>["db"],
  over: Partial<typeof failedPayments.$inferInsert>,
): string {
  const id = `fp_${++seq}`;
  runStatement(
    sqlite,
    db.insert(failedPayments).values({
      id,
      accountId: A,
      stripeEventId: `evt_${id}`,
      stripeInvoiceId: `in_${id}`,
      stripeCustomerId: "cus_1",
      customerEmail: "jordan@example.com",
      customerName: "Jordan Lee",
      amountCents: 1000,
      currency: "usd",
      declineCategory: "soft",
      declineCode: "insufficient_funds",
      status: "active",
      detectedAt: new Date(NOW - DAY),
      ...over,
    }),
  );
  return id;
}

describe("J75: the loader", () => {
  let sqlite: ReturnType<typeof createInMemoryDb>["sqlite"];
  let db: ReturnType<typeof createInMemoryDb>["db"];

  beforeEach(() => {
    ({ sqlite, db } = createInMemoryDb());
    harness.db = db;
    runStatement(sqlite, db.insert(accounts).values({ id: A, name: "Alpha" }));
    runStatement(sqlite, db.insert(accounts).values({ id: B, name: "Beta" }));
  });

  it("totals the head over the rows on screen, by currency, as Recova's header does", async () => {
    seed(sqlite, db, { amountCents: 1000, detectedAt: new Date(NOW - 1 * DAY) });
    seed(sqlite, db, { amountCents: 2000, currency: "eur", detectedAt: new Date(NOW - 2 * DAY) });
    seed(sqlite, db, { amountCents: 5000, status: "recovered", detectedAt: new Date(NOW - 3 * DAY) });
    seed(sqlite, db, { amountCents: 7000, detectedAt: new Date(NOW - 4 * DAY) });
    const out = await load("/recovery/payments?perPage=10&sort=newest");
    expect(out.header.atRisk).toEqual(
      expect.arrayContaining([
        { currency: "usd", cents: 8000 },
        { currency: "eur", cents: 2000 },
      ]),
    );
    expect(out.header.recovered).toEqual([{ currency: "usd", cents: 5000 }]);
    expect(out.header.ratePct).toBe(25);
  });

  it("names the next step by Foxhound's schedule and counts done of total", async () => {
    const id = seed(sqlite, db, { declineCategory: "soft" });
    const steps = [
      { stepType: "retry_early", stepNumber: 1, executedAt: new Date(NOW - DAY), result: "retry_card_declined" },
      { stepType: "email_day1", stepNumber: 2, executedAt: null, result: null },
      { stepType: "retry_day2", stepNumber: 3, executedAt: null, result: null },
    ];
    steps.forEach((s, i) =>
      runStatement(
        sqlite,
        db.insert(recoverySteps).values({
          id: `st_${i}`,
          accountId: A,
          failedPaymentId: id,
          stepType: s.stepType,
          stepNumber: s.stepNumber,
          scheduledAt: new Date(NOW),
          executedAt: s.executedAt,
          result: s.result,
        } as typeof recoverySteps.$inferInsert),
      ),
    );
    const out = await load("/recovery/payments");
    expect(out.result.payments[0]!.steps).toEqual({ completed: 1, total: 3, next: "Day 1 email" });
  });

  it("counts a customer's other failures and flags a note, sending no raw note text", async () => {
    seed(sqlite, db, { stripeCustomerId: "cus_r", notes: "Called them" });
    seed(sqlite, db, { stripeCustomerId: "cus_r" });
    seed(sqlite, db, { stripeCustomerId: "cus_r" });
    const out = await load("/recovery/payments");
    const first = out.result.payments[0]!;
    expect(out.result.payments.map((p) => p.priorFailures)).toEqual([2, 2, 2]);
    expect(out.result.payments.some((p) => p.hasNote)).toBe(true);
    expect(JSON.stringify(first)).not.toContain("Called them");
    expect(first).not.toHaveProperty("stripeCustomerId");
  });

  async function exportRows(path: string, accountId = A): Promise<string[]> {
    const res = (await exportRoute.loader({
      context: contextFor(accountId),
      request: new Request(`https://foxhoundapp.test${path}`),
      params: {},
    } as never)) as Response;
    expect(res.status).toBe(200);
    return (await res.text()).trim().split("\n").slice(1);
  }

  it("exports the rows on screen, as Recova's Export CSV does, never every filtered row", async () => {
    for (let i = 0; i < 30; i++) seed(sqlite, db, { detectedAt: new Date(NOW - (i + 1) * 60_000) });
    expect(await exportRows("/recovery/payments/export.csv")).toHaveLength(25);
    expect(await exportRows("/recovery/payments/export.csv?perPage=10&page=3")).toHaveLength(10);
    expect(await exportRows("/recovery/payments/export.csv?page=2")).toHaveLength(5);
    expect(await exportRows("/recovery/payments/export.csv?perPage=all")).toHaveLength(30);
  });
});
