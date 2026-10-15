import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cloudflareContext } from "~/lib/cloudflare-context";
import { authContext } from "~/lib/auth/context";
import { DISPUTE_FEE_CAP_CENTS } from "~/lib/constants";

// J66, row S13: the disputes list, against Recova's real page.
//
// Recova is the spec: app/(app)/disputes/dashboard/page.tsx (blob c97c3e93),
// DisputesDashboardView.tsx (3c1b7a98) and SyncDisputeLink.tsx (d2c2a744).
// The page is a 1280px column headed "Dashboard"; a row of stat cards that
// shows on the empty state too; then either the empty card or the table
// (Customer with the email beneath, Amount, Reason, status, Deadline as "18d",
// View); then the sync control. Look is Capsomer's (Q10), teal (Q11).
//
// Not built here, each a stop-and-report item of TASK-seven-walked-pages.md
// item 6: Recova's nine status labels (a), the "Submitted by" and "Saved vs
// Smart Disputes" cards (b), and the Mode and Fee columns (c). The Recovery
// cross-sell card is approved as not built (APPROVED-DIFFERENCES 2026-09-19).

// The loader reads through getDb(env); the in-memory database stands in for D1.
const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const route = await import("~/routes/app/disputes/index");
const Page = route.default as unknown as (props: {
  loaderData: Record<string, unknown>;
  actionData?: unknown;
}) => ReactElement;
const { computeDisputeStats } = await import("~/lib/disputes/stats");
const { deadlineShort } = await import("~/lib/disputes/labels");
const { createInMemoryDb } = await import("./helpers/inmemory-db");

const NOW = Date.parse("2026-10-15T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

interface Row {
  id: string;
  customerName: string | null;
  customerEmail: string | null;
  stripeCustomerId: string | null;
  stripeChargeId: string;
  amountCents: number;
  currency: string;
  reason: string;
  state: string;
  evidenceDeadline: Date | null;
}

function row(over: Partial<Row> & { id: string }): Row {
  return {
    customerName: "Ada Lovelace",
    customerEmail: "ada@example.com",
    stripeCustomerId: `cus_${over.id}`,
    stripeChargeId: `ch_${over.id}`,
    amountCents: 4_900,
    currency: "usd",
    reason: "product_not_received",
    state: "pending_review",
    evidenceDeadline: new Date(NOW + 18 * DAY),
    ...over,
  };
}

function loaderData(over: Record<string, unknown> = {}) {
  return {
    disputes: [row({ id: "d1" })],
    stats: {
      openCount: 1,
      atStake: [{ currency: "usd", cents: 4_900 }],
      feesOwed: [],
      // The page's old loader fields, so the red run rendered the old page and
      // the assertions decided, not a TypeError. Unread by the new page.
      needsActionCount: 1,
      atStakeCents: 4_900,
      winRatePct: null,
      wonCount: 0,
      lostCount: 0,
      feesOwedCents: 0,
    },
    currency: "usd",
    health: null,
    nowMs: NOW,
    isDemo: false,
    ...over,
  };
}

function render(data: Record<string, unknown>, actionData?: unknown): string {
  const Stub = createRoutesStub([
    { path: "/disputes", Component: () => createElement(Page, { loaderData: data, actionData }) },
  ]);
  return renderToStaticMarkup(createElement(Stub, { initialEntries: ["/disputes"] }));
}

const strip = (s: string) => s.replace(/<[^>]+>/g, "").trim();
const text = (html: string) => html.replaceAll("&#x27;", "'").replaceAll("&amp;", "&");
const headings = (html: string, level: 1 | 2) =>
  [...html.matchAll(new RegExp(`<h${level}[^>]*>(.*?)</h${level}>`, "g"))].map((m) => strip(m[1]!));
const columnHeads = (html: string) =>
  [...html.matchAll(/<th scope="col"[^>]*>(.*?)<\/th>/g)].map((m) => strip(m[1]!));
const bodyRows = (html: string) => [...html.matchAll(/<tr data-dispute="[^"]*"[^>]*>(.*?)<\/tr>/g)].map((m) => m[1]!);
/** The body rows, asserted present first, so a check over the rows never passes
 *  on an empty list (RULES 6.2) and a missing table fails an assertion. */
function rowsOf(html: string): string[] {
  const rows = bodyRows(html);
  expect(rows.length, "body rows rendered").toBeGreaterThan(0);
  return rows;
}
const cells = (rowHtml: string) => [...rowHtml.matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((m) => m[1]!);
/** The stat cards' labels, in order, from Foxhound's StatCard (label paragraph). */
const statLabels = (html: string) =>
  [...html.matchAll(/<p class="font-mono text-micro uppercase tracking-wide text-text-tertiary">(.*?)<\/p>/g)].map(
    (m) => strip(m[1]!),
  );

describe("/disputes renders Recova's disputes dashboard", () => {
  it("heads the page 'Dashboard', as Recova's PageHeader does", () => {
    expect(headings(render(loaderData()), 1)).toEqual(["Dashboard"]);
  });

  it("sits in Recova's 1280px column with its padding", () => {
    // page.tsx: <main className="max-w-[1280px] mx-auto px-4 md:px-8 py-8 md:py-10">
    expect(render(loaderData())).toContain('class="mx-auto max-w-[1280px] px-4 md:px-8 py-8 md:py-10"');
  });

  it("shows Recova's stat cards that have a source, in Recova's order, then Win rate", () => {
    // Win rate is not Recova's card. It stays, last, because /features (J60)
    // claims a historical win rate here, as Recova's features-data.ts does; a
    // question for Dustin in the J66 pull request.
    const html = render(loaderData());
    expect(statLabels(html)).toEqual(["Open disputes", "At stake", "Fees owed", "Win rate"]);
    expect(html).not.toContain("Needs action");
  });

  it("does not show the two claim cards held for Dustin (TASK item 6 (b))", () => {
    const html = render(loaderData());
    expect(html).not.toContain("Submitted by");
    expect(html).not.toContain("Saved vs Smart Disputes");
  });

  it("shows the stat cards on the empty state too, as Recova's view does", () => {
    const html = render(
      loaderData({ disputes: [], stats: { openCount: 0, atStake: [], feesOwed: [], winRatePct: null, wonCount: 0, lostCount: 0 } }),
    );
    expect(statLabels(html)).toEqual(["Open disputes", "At stake", "Fees owed", "Win rate"]);
    expect(html).toContain("$0.00");
  });

  it("says Recova's empty sentences, in Capsomer's empty component", () => {
    const html = text(
      render(
        loaderData({ disputes: [], stats: { openCount: 0, atStake: [], feesOwed: [], winRatePct: null, wonCount: 0, lostCount: 0 } }),
      ),
    );
    expect(html).toContain('class="cap-empty"');
    expect(html).toContain("No disputes yet.");
    expect(html).toContain("When a customer disputes a charge, Foxhound automatically builds your response.");
  });

  it("shows each currency's total on its own, never a sum across currencies (RULES 3.20)", () => {
    const html = render(
      loaderData({
        stats: {
          openCount: 2,
          atStake: [
            { currency: "usd", cents: 4_900 },
            { currency: "eur", cents: 2_500 },
          ],
          feesOwed: [],
          winRatePct: null,
          wonCount: 0,
          lostCount: 0,
        },
      }),
    );
    expect(html).toContain("$49.00");
    expect(html).toContain("€25.00");
  });

  it("puts the rows in a Capsomer table in a named, focusable region", () => {
    const html = render(loaderData());
    expect(html).toMatch(/<div class="cap-table-wrap" data-cap="table" role="region" aria-label="Disputes" tabindex="0">/);
    expect(html).toContain('<table class="cap-table">');
  });

  it("has Recova's columns in Recova's order, without Mode and Fee (TASK item 6 (c))", () => {
    expect(columnHeads(render(loaderData()))).toEqual(["Customer", "Amount", "Reason", "Foxhound status", "Deadline", "View"]);
  });

  it("names the View column for assistive tech only, as Recova's aria-label does", () => {
    expect(render(loaderData())).toMatch(/<th scope="col"[^>]*><span class="sr-only">View<\/span><\/th>/);
  });

  it("shows the customer's name with the email beneath, and the name is not a link", () => {
    const [first] = rowsOf(render(loaderData()));
    const customer = cells(first!)[0]!;
    expect(strip(customer)).toBe("Ada Lovelaceada@example.com");
    expect(customer).not.toContain("<a ");
  });

  it("says Unknown for a dispute with no customer name, as Recova does", () => {
    const [first] = rowsOf(
      render(loaderData({ disputes: [row({ id: "d1", customerName: null, customerEmail: null })] })),
    );
    expect(strip(cells(first!)[0]!)).toBe("Unknown");
  });

  it("right-aligns the amount in tabular figures", () => {
    const html = render(loaderData());
    expect(html).toMatch(/<th scope="col" data-num="">Amount<\/th>/);
    const [first] = rowsOf(html);
    expect(first).toMatch(/<td data-num="">\$49\.00<\/td>/);
  });

  it("shows the status as a Capsomer pill", () => {
    const [first] = rowsOf(render(loaderData()));
    expect(cells(first!)[3]).toContain('class="cap-pill"');
    expect(strip(cells(first!)[3]!)).toBe("Pending review");
  });

  it("shows the deadline as Recova does: days only, '18d'", () => {
    const [first] = rowsOf(render(loaderData()));
    expect(strip(cells(first!)[4]!)).toBe("18d");
  });

  it("leaves the deadline blank once the dispute is resolved, and when there is none", () => {
    const html = render(
      loaderData({
        disputes: [
          row({ id: "won", state: "resolved_won" }),
          row({ id: "none", evidenceDeadline: null }),
        ],
      }),
    );
    for (const r of rowsOf(html)) expect(strip(cells(r)[4]!)).toBe("");
  });

  it("opens the dispute from Recova's View link in the last column", () => {
    const [first] = rowsOf(render(loaderData()));
    const view = cells(first!)[5]!;
    expect(view).toMatch(/<a [^>]*href="\/disputes\/d1"/);
    expect(strip(view)).toMatch(/^View/);
  });

  it("keeps the rows in the order the loader gives them", () => {
    const html = render(
      loaderData({ disputes: [row({ id: "newest" }), row({ id: "older", evidenceDeadline: new Date(NOW + DAY) })] }),
    );
    expect([...html.matchAll(/<tr data-dispute="([^"]+)"/g)].map((m) => m[1])).toEqual(["newest", "older"]);
  });

  it("shows the Intelligence health score beside the name when Intelligence is on", () => {
    const html = render(loaderData({ health: { cus_d1: 82 } }));
    const customer = cells(rowsOf(html)[0]!)[0]!;
    expect(customer).toContain("82");
    expect(customer).toContain('<span class="sr-only">Intelligence health score </span>');
  });

  it("shows no health score without Intelligence", () => {
    const customer = cells(rowsOf(render(loaderData({ health: null })))[0]!)[0]!;
    expect(customer).not.toContain("health score");
  });

  it("carries no amber anywhere on the page (Q11)", () => {
    expect(render(loaderData())).not.toMatch(/amber/);
  });
});

describe("the sync control, on Capsomer's parts", () => {
  it("opens from a Capsomer link button with Recova's words", () => {
    const html = render(loaderData());
    expect(html).toMatch(/<button type="button" class="cap-btn" data-variant="link"[^>]*>Sync dispute from Stripe<\/button>/);
  });

  it("imports through a Capsomer input and a primary Capsomer button", () => {
    const html = render(loaderData(), { sync: { ok: false, message: 'Stripe dispute IDs start with "dp_".' } });
    expect(html).toMatch(/<input class="cap-input"[^>]*id="sync_dispute_id"/);
    expect(html).toMatch(/<button type="submit" class="cap-btn" data-variant="primary"[^>]*>Import dispute<\/button>/);
    expect(html).toMatch(/<button type="button" class="cap-btn" data-variant="quiet"[^>]*>Cancel<\/button>/);
  });

  it("reports the result as a Capsomer status, announced", () => {
    const html = render(loaderData(), { sync: { ok: true, message: "Dispute imported." } });
    expect(html).toMatch(/role="status"/);
    expect(html).toMatch(/<span class="cap-status" data-tone="ok">.*Dispute imported\.<\/span>/);
  });
});

describe("deadlineShort", () => {
  it("is Recova's whole-days form", () => {
    expect(deadlineShort(18, false)).toBe("18d");
    expect(deadlineShort(0, false)).toBe("0d");
    expect(deadlineShort(-2, false)).toBe("-2d");
  });

  it("is blank once resolved or with no deadline", () => {
    expect(deadlineShort(5, true)).toBe("");
    expect(deadlineShort(null, false)).toBe("");
  });
});

describe("computeDisputeStats", () => {
  const base = {
    state: "pending_review",
    amountCents: 10_000,
    currency: "usd",
    resolvedFeeCents: null as number | null,
    resolvedFeeCurrency: null as string | null,
    submittedAt: null as Date | null,
  };

  it("counts open disputes and keeps the money at stake per currency", () => {
    const stats = computeDisputeStats([
      { ...base, state: "draft", amountCents: 5_000 },
      { ...base, amountCents: 7_000, currency: "eur" },
      { ...base, state: "resolved_won", amountCents: 100_000 },
    ]);
    expect(stats.openCount).toBe(2);
    expect(stats.atStakeParts).toEqual([
      { currency: "usd", cents: 5_000 },
      { currency: "eur", cents: 7_000 },
    ]);
  });

  it("owes a fee only on a win Foxhound submitted, from the stored fee in its own currency", () => {
    const stats = computeDisputeStats([
      { ...base, state: "resolved_won", submittedAt: null },
      { ...base, state: "resolved_won", currency: "eur", resolvedFeeCents: 1_234, resolvedFeeCurrency: "eur", submittedAt: new Date(NOW) },
      { ...base, state: "resolved_lost", submittedAt: new Date(NOW) },
    ]);
    expect(stats.feesOwedParts).toEqual([{ currency: "eur", cents: 1_234 }]);
  });

  it("keeps the win rate over resolved disputes only, null until one resolves", () => {
    expect(computeDisputeStats([{ ...base, state: "draft" }]).winRatePct).toBeNull();
    const stats = computeDisputeStats([
      { ...base, state: "resolved_won", submittedAt: new Date(NOW) },
      { ...base, state: "resolved_lost" },
      { ...base, state: "resolved_lost" },
      { ...base, state: "draft" },
    ]);
    expect(stats).toMatchObject({ winRatePct: 33, wonCount: 1, lostCount: 2 });
  });

  it("projects the capped fee when none is stamped yet", () => {
    const stats = computeDisputeStats([
      { ...base, state: "resolved_won", amountCents: 1_000_000, submittedAt: new Date(NOW) },
    ]);
    expect(stats.feesOwedParts).toEqual([{ currency: "usd", cents: DISPUTE_FEE_CAP_CENTS }]);
  });
});

describe("the loader", () => {
  const ACCOUNT = "acct_j66";
  let env: Env;
  let sqlite: ReturnType<typeof createInMemoryDb>["sqlite"];

  function context() {
    return {
      get(key: unknown) {
        if (key === cloudflareContext) return { env, ctx: {} as ExecutionContext, nonce: "n" };
        if (key === authContext) return { email: "owner@example.com", membership: { accountId: ACCOUNT }, isDemo: false };
        throw new Error("unexpected context key");
      },
    } as never;
  }

  function dispute(id: string, createdAt: number, deadline: number, currency = "usd", amount = 4_900) {
    sqlite
      .prepare(
        "INSERT INTO disputes (id, account_id, stripe_dispute_id, stripe_charge_id, stripe_customer_id, customer_name, amount_cents, currency, reason, status, state, evidence_deadline, created_at) VALUES (?, ?, ?, ?, ?, 'Ada', ?, ?, 'fraudulent', 'needs_response', 'pending_review', ?, ?)",
      )
      .run(id, ACCOUNT, `dp_${id}`, `ch_${id}`, `cus_${id}`, amount, currency, deadline, createdAt);
  }

  beforeEach(() => {
    const made = createInMemoryDb();
    sqlite = made.sqlite;
    harness.db = made.db;
    env = {} as Env;
    sqlite.prepare("INSERT INTO accounts (id, name, created_at) VALUES (?, 'Acme', 1000)").run(ACCOUNT);
  });

  const load = () =>
    route.loader({ context: context(), request: new Request("https://x.test/disputes"), params: {} } as never) as Promise<{
      disputes: { id: string }[];
      stats: { openCount: number; atStake: { currency: string; cents: number }[] };
      health: Record<string, number> | null;
    }>;

  it("lists newest first, as Recova orders by created_at, never re-sorted by deadline", async () => {
    dispute("old_near", NOW - 5 * DAY, NOW + DAY);
    dispute("new_far", NOW - DAY, NOW + 20 * DAY);
    const data = await load();
    expect(data.disputes.map((d) => d.id)).toEqual(["new_far", "old_near"]);
  });

  it("totals the money at stake per currency", async () => {
    dispute("a", NOW - DAY, NOW + DAY, "usd", 1_000);
    dispute("b", NOW - 2 * DAY, NOW + DAY, "eur", 2_000);
    dispute("c", NOW - 3 * DAY, NOW + DAY, "usd", 500);
    const data = await load();
    expect(data.stats.openCount).toBe(3);
    expect(data.stats.atStake).toEqual([
      { currency: "usd", cents: 1_500 },
      { currency: "eur", cents: 2_000 },
    ]);
  });

  it("reads health scores only when Intelligence is on", async () => {
    dispute("a", NOW - DAY, NOW + DAY);
    sqlite
      .prepare(
        "INSERT INTO customer_context (id, account_id, stripe_customer_id, health_score, created_at, updated_at) VALUES ('cc1', ?, 'cus_a', 77, 1, 1)",
      )
      .run(ACCOUNT);
    expect((await load()).health).toBeNull();

    sqlite
      .prepare(
        "INSERT INTO account_subscriptions (id, account_id, product, status, created_at) VALUES ('sub1', ?, 'intelligence', 'active', 1)",
      )
      .run(ACCOUNT);
    expect((await load()).health).toEqual({ cus_a: 77 });
  });
});
