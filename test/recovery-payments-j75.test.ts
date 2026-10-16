import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { accounts, failedPayments, recoverySteps } from "~/db/schema";
import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { BULK_ACTION_CONFIRM_THRESHOLD, BULK_ACTION_MAX_PER_SUBMISSION } from "~/lib/constants";
import type { BulkActionResult } from "~/lib/recovery/bulk-results";

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

const ROUTE_SOURCE = readFileSync("app/routes/app/recovery/payments/index.tsx", "utf8");
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

function columnHeads(html: string): string[] {
  const thead = html.match(/<thead>([\s\S]*?)<\/thead>/)?.[1] ?? "";
  return [...thead.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => text(m[1]!));
}

// ---- The head ----

describe("J75: Recova's head", () => {
  it("says Recova's line, in whole units, with no clause of Foxhound's own", () => {
    const html = render(
      data({
        header: {
          atRisk: [{ currency: "usd", cents: 123_456 }],
          recovered: [{ currency: "usd", cents: 5_000 }],
          ratePct: 33,
        },
      }),
    );
    expect(text(html)).toContain("$1,235 at risk · $50 recovered · 33% recovery rate");
    expect(html).not.toContain("for the current filters");
  });

  it("leaves the rate off at zero, as Recova does", () => {
    const html = render(data());
    expect(text(html)).toContain("$50 at risk · $0 recovered");
    expect(text(html)).not.toContain("0% recovery rate");
  });

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

  it("puts Export CSV in the head as a Capsomer button", () => {
    const html = render(data());
    expect(html).toMatch(/<a[^>]*class="cap-btn"[^>]*href="\/recovery\/payments\/export\.csv"[^>]*>Export CSV<\/a>|<a[^>]*href="\/recovery\/payments\/export\.csv"[^>]*class="cap-btn"[^>]*>Export CSV<\/a>/);
    expect(html).toMatch(/<h1[^>]*>Payments<\/h1>/);
  });
});

// ---- The cards ----

describe("J75: Recova's five cards, on Capsomer panels", () => {
  it("shows Showing, Active, Recovered, Cancelled and Recovery rate in order", () => {
    const html = render(data());
    const cards = html.slice(html.indexOf('aria-label="Payment counts"'));
    const labels = [...cards.matchAll(/<header class="cap-panel-head"><h2>([^<]+)<\/h2>/g)].map((m) => m[1]).slice(0, 5);
    expect(labels).toEqual(["Showing", "Active", "Recovered", "Cancelled", "Recovery rate"]);
  });

  it("uses no Foxhound-only card or badge component", () => {
    expect(ROUTE_SOURCE).not.toContain("~/components/stat-card");
    expect(ROUTE_SOURCE).not.toContain("~/components/badge");
  });
});

// ---- The filter panel ----

describe("J75: Recova's filter panel", () => {
  it("puts the search and the status filter in the panel's first row, the status filter after the search", () => {
    const html = render(data());
    const form = html.match(/<form[^>]*method="get"[\s\S]*?<\/form>/)?.[0] ?? "";
    expect(form).toContain('aria-label="Search payments"');
    expect(form).toContain('placeholder="Search by name, email, or plan..."');
    expect(form).toMatch(/<fieldset class="cap-seg"/);
    expect(form.indexOf('aria-label="Search payments"')).toBeLessThan(form.indexOf("cap-seg"));
  });

  it("names the status filter and lists Recova's five with their counts", () => {
    const html = render(data({ pillCounts: { all: 9, active: 4, recovered: 3, failedUnrecovered: 1, cancelled: 1 } }));
    const seg = html.match(/<fieldset class="cap-seg"[\s\S]*?<\/fieldset>/)?.[0] ?? "";
    expect(text(seg.match(/<legend[^>]*>([\s\S]*?)<\/legend>/)?.[1] ?? "")).toBe("Filter by status");
    const labels = [...seg.matchAll(/<label[^>]*>([\s\S]*?)<\/label>/g)].map((m) => text(m[1]!));
    expect(labels).toEqual(["All 9", "Active 4", "Recovered 3", "Cancelled 1", "Failed 1"]);
    expect([...seg.matchAll(/type="radio"/g)]).toHaveLength(5);
  });

  it("names each select as Recova does and shows no visible label over it", () => {
    const html = render(data());
    expect(html).toContain('aria-label="Filter by date range"');
    expect(html).toContain('aria-label="Filter by decline category"');
    expect(html).toContain('aria-label="Filter by sort order"');
    expect(html).not.toContain(">Name, email, or plan<");
    expect(html).not.toContain(">Rows per page</span></label>");
  });

  it("uses Recova's sort words and decline words", () => {
    const html = render(data());
    const sort = html.match(/<select[^>]*aria-label="Filter by sort order"[\s\S]*?<\/select>/)?.[0] ?? "";
    expect([...sort.matchAll(/<option[^>]*>([^<]+)<\/option>/g)].map((m) => m[1])).toEqual([
      "Newest first",
      "Oldest first",
      "Highest amount",
      "Lowest amount",
    ]);
    const decline = html.match(/<select[^>]*aria-label="Filter by decline category"[\s\S]*?<\/select>/)?.[0] ?? "";
    const words = [...decline.matchAll(/<option[^>]*>([^<]+)<\/option>/g)].map((m) => m[1]);
    expect(words.slice(0, 5)).toEqual(["All declines", "Soft", "Network", "Expired", "Fraud"]);
  });

  it("applies a filter on change, with no Filter button", () => {
    const html = render(data());
    // The form must be there for its absent button to mean anything.
    expect(html).toContain('aria-label="Search payments"');
    expect(text(html)).not.toMatch(/\bFilter\b(?! by)/);
  });

  it("draws Recova's amount slider: the word, the span over the track, the ends under it", () => {
    const html = render(data({ filters: { ...data().filters, amountMinCents: 2_000, amountMaxCents: 100_000 } }));
    const t = text(html);
    expect(t).toContain("Amount $20 – $1000+");
    expect(t).toContain("$0 $1000+");
    expect(html).toContain('aria-label="Minimum amount"');
    expect(html).toContain('aria-label="Maximum amount"');
    expect(html).toContain('step="1000"');
  });

  it("shows the result count in the panel, and Clear filters only when a filter is on", () => {
    const off = render(data());
    expect(text(off)).toContain("1 result");
    expect(text(off)).not.toContain("Clear filters");
    const on = render(
      data({
        result: { payments: [row(), row({ id: "fp_2" })], totalCount: 2, page: 1, totalPages: 1, pageSize: 25 },
        filters: { ...data().filters, search: "jordan" },
      }),
    );
    expect(text(on)).toContain("2 results");
    expect(on).toMatch(/<a[^>]*href="\/recovery\/payments"[^>]*>Clear filters<\/a>/);
  });
});

// ---- Rows per page ----

describe("J75: Recova's rows-per-page links, defaulting to 25", () => {
  it("is a labelled row of links between the panel and the table", () => {
    const html = render(data());
    const nav = html.match(/<nav[^>]*aria-label="Rows per page"[\s\S]*?<\/nav>/)?.[0] ?? "";
    expect(text(nav)).toBe("Rows per page 10 25 50 100 All");
    expect(nav).toMatch(/aria-current="true"[^>]*>25<|>25<\/a>/);
    expect(nav.match(/<a[^>]*aria-current="true"[^>]*>([^<]+)</)?.[1]).toBe("25");
    expect(html.indexOf('aria-label="Rows per page"')).toBeGreaterThan(html.indexOf("</form>"));
    expect(html.indexOf('aria-label="Rows per page"')).toBeLessThan(html.indexOf("<table"));
  });

  it("defaults to 25 in the loader", async () => {
    const { sqlite, db } = createInMemoryDb();
    harness.db = db;
    runStatement(sqlite, db.insert(accounts).values({ id: A, name: "Alpha" }));
    const out = await load("/recovery/payments");
    expect(out.filters.pageSize).toBe(25);
  });
});

// ---- The table ----

describe("J75: Recova's table on Capsomer's", () => {
  it("has Recova's columns after the select-all box", () => {
    const html = render(data());
    expect(html).toContain('class="cap-table"');
    expect(columnHeads(html)).toEqual(["Select all payments", "Customer", "Amount", "Decline", "Steps", "Status", "Detected"]);
  });

  it("says Nx failure for a repeat customer, and note when the payment has one", () => {
    const html = render(data({ result: { ...data().result, payments: [row({ priorFailures: 2, hasNote: true })] } }));
    expect(text(html)).toContain("3x failure");
    expect(text(html)).toContain("note");
    expect(html).not.toContain("prior</span>");
  });

  it("shows the email under the name only when there is a name", () => {
    const named = render(data());
    expect(text(named)).toContain("Jordan Lee jordan@example.com");
    const unnamed = render(data({ result: { ...data().result, payments: [row({ customerName: null })] } }));
    // The box's hidden name says the email too; what is seen says it once.
    const seen = unnamed.replace(/<span class="sr-only">[^<]*<\/span>/g, "");
    expect(text(seen).match(/jordan@example\.com/g)).toHaveLength(1);
  });

  it("shows the decline as a pill with its code under it", () => {
    const html = render(data());
    expect(html).toMatch(/class="cap-pill"[^>]*>(?:<[^>]+>)*Soft/);
    expect(html).toMatch(/insufficient_funds/);
  });

  it("shows steps as done/total with Recova's Next line", () => {
    const html = render(data());
    expect(text(html)).toContain("1/4");
    expect(text(html)).toContain("Next: Day 3 email");
  });

  it("shows the tab word in the status pill, never the database value", () => {
    const html = render(data({ result: { ...data().result, payments: [row({ status: "failed_unrecovered" })] } }));
    expect(text(html)).toContain("Failed");
    expect(html).not.toContain(">failed_unrecovered<");
  });

  it("dates a payment as Recova does: time ago, then the short date in UTC", () => {
    const html = render(data());
    expect(text(html)).toContain("3d ago");
    expect(text(html)).toContain("Oct 13, 2026");
  });

  it("makes the whole row one link, and keeps Recova's View link", () => {
    const html = render(data());
    expect(html).toMatch(/<a[^>]*class="cap-table-open"[^>]*href="\/recovery\/payments\/fp_1"|<a[^>]*href="\/recovery\/payments\/fp_1"[^>]*class="cap-table-open"/);
    expect(text(html)).toContain("View");
  });

  it("gives each row box Recova's name", () => {
    const html = render(data());
    expect(html).toContain("Select payment from Jordan Lee");
  });
});

describe("J75: Recova's empty state", () => {
  it("says Recova's two lines in place of the table", () => {
    const html = render(data({ result: { payments: [], totalCount: 0, page: 1, totalPages: 1, pageSize: 25 } }));
    expect(text(html)).toContain("No payments match your filters");
    expect(text(html)).toContain("Try adjusting your search or filters");
    expect(html).not.toContain("<table");
  });
});

describe("J75: Recova's pager", () => {
  it("says which payments are showing, with both ends present", () => {
    const html = render(
      data({ result: { payments: [row()], totalCount: 60, page: 1, totalPages: 3, pageSize: 25 } }),
    );
    const nav = html.match(/<nav class="cap-pagination"[\s\S]*?<\/nav>/)?.[0] ?? "";
    expect(text(nav)).toContain("Showing 1–25 of 60 payments");
    expect(nav).toMatch(/data-kind="prev"[^>]*aria-disabled="true"|aria-disabled="true"[^>]*data-kind="prev"/);
    expect(nav).toMatch(/href="\/recovery\/payments\?page=2"/);
  });

  it("counts every row when All is chosen", () => {
    const html = render(
      data({
        result: { payments: [row()], totalCount: 40, page: 1, totalPages: 1, pageSize: "all" },
        filters: { ...data().filters, pageSize: "all" },
      }),
    );
    expect(text(html)).toContain("Showing 1–40 of 40 payments");
  });
});

// ---- Bulk ----

describe("J75: the bulk result, where Recova shows it", () => {
  const applied: BulkActionResult = {
    intent: "cancel",
    results: [
      { id: "fp_1", ok: true, reason: null, detail: null },
      { id: "fp_2", ok: false, reason: "not_active", detail: null },
    ],
  };

  it("sits between the cards and the filter panel, in Recova's words, failures first", () => {
    const html = render(
      data({ result: { ...data().result, payments: [row(), row({ id: "fp_2", customerName: "Sam Rivera" })] } }),
      { bulk: applied },
    );
    const banner = html.indexOf("Cancelled: 1 succeeded, 1 failed");
    expect(banner).toBeGreaterThan(html.indexOf('aria-label="Payment counts"'));
    expect(banner).toBeLessThan(html.indexOf('method="get"'));
    const list = text(html.slice(banner));
    expect(list.indexOf("Sam Rivera")).toBeLessThan(list.indexOf("Jordan Lee"));
    expect(list).toContain("No longer active");
  });

  it("uses Capsomer's banner, crit when anything failed", () => {
    const html = render(data(), { bulk: applied });
    expect(html).toMatch(/class="cap-banner"[^>]*data-tone="crit"|data-tone="crit"[^>]*class="cap-banner"/);
  });

  it("is built on Capsomer's bulk bar and confirm dialog, with the approved limits", () => {
    expect(ROUTE_SOURCE).toContain('className="cap-bulk"');
    expect(ROUTE_SOURCE).toContain('className="cap-bulk-count" role="status"');
    expect(ROUTE_SOURCE).toContain('from "capsomer/react/confirm-dialog"');
    expect(ROUTE_SOURCE).toContain("actionable.length > BULK_ACTION_CONFIRM_THRESHOLD");
    expect(ROUTE_SOURCE).toContain("actionable.length > BULK_ACTION_MAX_PER_SUBMISSION");
    expect(BULK_ACTION_CONFIRM_THRESHOLD).toBe(25);
    expect(BULK_ACTION_MAX_PER_SUBMISSION).toBe(100);
  });

  it("clears after Recova's 3 seconds (PaymentsClient.tsx doBulkAction, setTimeout 3000)", async () => {
    const list = await import("~/lib/recovery/payments-list");
    expect((list as Record<string, unknown>).BULK_RESULT_DISMISS_MS).toBe(3000);
    expect(ROUTE_SOURCE).toMatch(/setTimeout\(\s*\(\) => setDismissedFor\(bulk\),\s*BULK_RESULT_DISMISS_MS\s*\)/);
  });

  it("says Working... on the pressed button, as Recova's does", () => {
    expect(ROUTE_SOURCE).toContain('"Working..."');
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

  it("keeps the export to the signed-in account", async () => {
    seed(sqlite, db, { accountId: B, customerEmail: "other@beta.test" });
    seed(sqlite, db, {});
    const rows = await exportRows("/recovery/payments/export.csv");
    expect(rows).toHaveLength(1);
    expect(rows.join("\n")).not.toContain("other@beta.test");
  });

  // ALREADY LANDED before J75 (queries.server.ts:100-105); kept as the proof.
  it("never lists another account's payment", async () => {
    seed(sqlite, db, { accountId: B, customerEmail: "other@beta.test" });
    seed(sqlite, db, {});
    const out = await load("/recovery/payments");
    expect(out.result.payments.map((p) => p.customerEmail)).toEqual(["jordan@example.com"]);
    expect(out.globalCounts.all).toBe(1);
  });
});
