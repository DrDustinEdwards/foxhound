import { readFileSync } from "node:fs";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { describe, expect, it } from "vitest";

import { formatRelativeLastSeen, planTierPill } from "~/lib/intelligence/customer-directory";
import IntelligenceCustomersPage from "~/routes/app/intelligence/customers";

// J30 (job_2f939fd1c60f), row S17, under Dustin's Q10 and Q11 rulings of
// 2026-10-14: /intelligence/customers is Recova's page
// (app/(app)/intelligence/customers/page.tsx at blob 0413f035, with
// lib/intelligence-display.ts at blob 379635a7) built from Capsomer 0.9.0's
// components, teal throughout. Recova stays the spec for every section, label,
// column and their order, and for the page's 1280px column. The filter bar is
// Foxhound's, approved ("The customers page has a filter bar. "confirm",
// 2026-08-28", APPROVED-DIFFERENCES). The recommended-action chip waits for
// J78's producer (test/customers-heading-399.test.ts keeps that halt).
//
// Every assertion here was seen failing against the page before the rebuild
// (red output kept in the J30 notes).

const Page = IntelligenceCustomersPage as unknown as (props: {
  loaderData: Record<string, unknown>;
}) => ReactElement;

const SOURCE = readFileSync(new URL("../app/routes/app/intelligence/customers.tsx", import.meta.url), "utf8");

const NOW = Date.UTC(2026, 9, 15, 12);
const DAY = 24 * 60 * 60 * 1000;

interface Row {
  stripeCustomerId: string;
  customerName: string | null;
  customerEmail: string | null;
  currentPlanTier: string | null;
  mrrContributionCents: number;
  currency: string;
  healthScore: number | null;
  lastSeenAt: Date | null;
  recoverySignals: unknown;
  disputeSignals: unknown;
}

function row(over: Partial<Row> & { stripeCustomerId: string }): Row {
  return {
    customerName: "Sample Bakery",
    customerEmail: "owner@example.com",
    currentPlanTier: "growth",
    mrrContributionCents: 12_345,
    currency: "usd",
    healthScore: 55,
    lastSeenAt: new Date(NOW),
    recoverySignals: {},
    disputeSignals: {},
    ...over,
  };
}

interface Filters {
  search: string;
  tier: string;
  healthBand: string;
  sort: "health_asc" | "mrr_desc";
}

const NO_FILTERS: Filters = { search: "", tier: "", healthBand: "", sort: "health_asc" };

function render(
  opts: {
    customers?: Row[];
    totalCount?: number;
    totalMrrCents?: number;
    page?: number;
    totalPages?: number;
    filters?: Filters;
    accountName?: string | null;
  } = {},
): string {
  const customers = opts.customers ?? [row({ stripeCustomerId: "cus_sample_1" })];
  const loaderData = {
    entitled: true,
    result: {
      customers,
      totalCount: opts.totalCount ?? customers.length,
      totalMrrCents: opts.totalMrrCents ?? 123_450,
      page: opts.page ?? 1,
      totalPages: opts.totalPages ?? 1,
    },
    tiers: ["growth", "scale"],
    filters: opts.filters ?? NO_FILTERS,
    accountName: opts.accountName === undefined ? "Acme" : opts.accountName,
    nowMs: NOW,
  };
  const Stub = createRoutesStub([{ path: "/", Component: () => createElement(Page, { loaderData }) }]);
  return renderToStaticMarkup(createElement(Stub));
}

function headings(html: string): { level: number; text: string }[] {
  return [...html.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/g)].map((m) => ({
    level: Number(m[1]),
    text: m[2].replace(/<[^>]+>/g, ""),
  }));
}

/** The text of every cell in the first body row, in order. */
function firstRowCells(html: string): string[] {
  const tbody = html.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] ?? "";
  const tr = tbody.match(/<tr[^>]*>([\s\S]*?)<\/tr>/)?.[1] ?? "";
  return [...tr.matchAll(/<(td|th)[^>]*>([\s\S]*?)<\/\1>/g)].map((m) => m[2]);
}

describe("J30 customers: the page head", () => {
  it("is Capsomer's PageHead with the account's name and Recova's lead", () => {
    const html = render();
    expect(html).toMatch(/<header class="cap-page-head">[\s\S]*<h1 class="cap-page-head-title">Acme customers<\/h1>/);
    expect(html).toContain(
      '<p class="cap-page-head-lead">Sorted by health score, lowest first. Customers worth attention surface at the top.</p>',
    );
  });

  it("never renders Recova's doubled heading for an account with no name", () => {
    const html = render({ accountName: null });
    expect(html).toContain('<h1 class="cap-page-head-title">Customers</h1>');
    expect(html).not.toMatch(/Customers customers/i);
  });

  it("carries Recova's count line, with total MRR in cents", () => {
    const html = render({ totalCount: 12, totalMrrCents: 123_450 });
    expect(html).toContain("12 customers · $1,234.50/mo total MRR");
  });

  it("shows no count line when there are no customers, as Recova does", () => {
    const html = render({ customers: [], totalCount: 0, totalMrrCents: 0 });
    expect(html).not.toContain("/mo total MRR");
    expect(html).not.toContain("0 customers");
  });

  it("is a 1280px column with Recova's padding, and no <main> of its own", () => {
    const html = render();
    expect(html).toContain('class="mx-auto max-w-[1280px] px-4 py-8 md:px-8 md:py-10"');
    expect(html).not.toMatch(/<main[\s>]/);
  });
});

describe("J30 customers: the empty state", () => {
  it("is Recova's card, with its h2 and sentence, and no table or filter bar", () => {
    const html = render({ customers: [], totalCount: 0, totalMrrCents: 0 });
    expect(headings(html)).toEqual([
      { level: 1, text: "Acme customers" },
      { level: 2, text: "No customer data yet" },
    ]);
    expect(html).toContain(
      "Intelligence populates as customers transact in your Stripe account. Check back as data accumulates.",
    );
    expect(html).not.toContain("<table");
    expect(html).not.toContain("<form");
  });

  it("keeps the filter bar and says nothing matched when a filter leaves no rows", () => {
    const html = render({
      customers: [],
      totalCount: 0,
      totalMrrCents: 0,
      filters: { ...NO_FILTERS, search: "nobody" },
    });
    expect(html).toContain("<form");
    expect(html).not.toContain("No customer data yet");
    expect(html).toMatch(/class="cap-empty" data-kind="no-match"[\s\S]*No customers match these filters\./);
  });
});

describe("J30 customers: the table", () => {
  it("is Capsomer's table in a named, focusable region, with Recova's six columns in order", () => {
    const html = render();
    expect(html).toMatch(/<div class="cap-table-wrap" data-cap="table" role="region" aria-label="Customers" tabindex="0">/);
    expect(html).toContain('<table class="cap-table">');
    const heads = [...html.matchAll(/<th scope="col"[^>]*>([\s\S]*?)<\/th>/g)].map((m) => m[1].trim());
    expect(heads).toEqual(["Customer", "Plan", "MRR", "Health", "Last seen", "Signals"]);
  });

  it("names an unnamed customer as Recova does, never by email", () => {
    const html = render({ customers: [row({ stripeCustomerId: "cus_sample_2", customerName: null })] });
    expect(html).toContain("(unnamed)");
    expect(html).not.toContain("owner@example.com");
    expect(html).toContain('href="/intelligence/customers/cus_sample_2"');
  });

  it("shows MRR with cents and a dash for none, as Recova's formatAmount does", () => {
    const html = render({
      customers: [
        row({ stripeCustomerId: "cus_a", mrrContributionCents: 29_950 }),
        row({ stripeCustomerId: "cus_b", mrrContributionCents: 0 }),
      ],
    });
    expect(html).toContain("$299.50");
  });

  it("tones the health score by Foxhound's bands, without amber", () => {
    const html = render({
      customers: [
        row({ stripeCustomerId: "cus_a", healthScore: 12 }),
        row({ stripeCustomerId: "cus_b", healthScore: 55 }),
        row({ stripeCustomerId: "cus_c", healthScore: 90 }),
      ],
    });
    expect(html).toMatch(/text-error-text[^"]*">12</);
    expect(html).toMatch(/text-caution[^"]*">55</);
    expect(html).toMatch(/text-success-text[^"]*">90</);
  });

  it("uses Recova's lowercase last-seen words", () => {
    const cells = firstRowCells(render({ customers: [row({ stripeCustomerId: "cus_a", lastSeenAt: new Date(NOW) })] }));
    expect(cells[4]).toContain("today");
    expect(cells[4]).not.toContain("Today");
  });

  it("names the signals with Recova's words and leaves an empty cell blank", () => {
    const withSignals = render({
      customers: [
        row({
          stripeCustomerId: "cus_a",
          recoverySignals: { activeRecoveryId: "fp_1" },
          disputeSignals: { wonCount: 1 },
        }),
      ],
    });
    expect(withSignals).toContain('aria-label="Active recovery"');
    expect(withSignals).toContain("Dispute history");
    expect(withSignals).not.toContain("Active recovery in progress");
    expect(withSignals).not.toContain("Has dispute history");

    const none = firstRowCells(render({ customers: [row({ stripeCustomerId: "cus_b" })] }));
    expect(none[5].replace(/<[^>]+>/g, "").trim()).toBe("");
  });

  it("draws each plan as a Capsomer pill with Recova's sentence-case label", () => {
    const html = render({
      customers: [
        row({ stripeCustomerId: "cus_a", currentPlanTier: "growth" }),
        row({ stripeCustomerId: "cus_b", currentPlanTier: "scale" }),
      ],
    });
    expect(html).toMatch(/<span class="cap-pill" data-tone="info" data-variant="outline">Growth<\/span>/);
    expect(html).toMatch(/<span class="cap-pill" data-variant="outline">Scale<\/span>/);
  });
});

describe("J30 customers: plan pills", () => {
  it("labels Recova's five tiers in sentence case", () => {
    expect(planTierPill("starter").label).toBe("Starter");
    expect(planTierPill("growth").label).toBe("Growth");
    expect(planTierPill("scale").label).toBe("Scale");
    expect(planTierPill("pro").label).toBe("Pro");
    expect(planTierPill("hobby").label).toBe("Hobby");
  });

  it("gives a dash for no tier, and never shows a raw database value", () => {
    expect(planTierPill(null).label).toBe("-");
    expect(planTierPill("enterprise").label).toBe("Enterprise");
  });

  it("keeps Recova's three ranks of colour, teal-family tones only", () => {
    // Recova: starter, hobby and other tiers subtle; growth blue; scale and pro
    // amber. No amber (Q11): the top ranks take the strongest neutral.
    expect(planTierPill("starter").tone).toBe("nodata");
    expect(planTierPill("hobby").tone).toBe("nodata");
    expect(planTierPill("enterprise").tone).toBe("nodata");
    expect(planTierPill(null).tone).toBe("nodata");
    expect(planTierPill("growth").tone).toBe("info");
    expect(planTierPill("scale").tone).toBeUndefined();
    expect(planTierPill("pro").tone).toBeUndefined();
  });
});

describe("J30 customers: last seen", () => {
  it("matches Recova's lastSeenLabel word for word", () => {
    const now = new Date(NOW);
    const ago = (d: number) => new Date(NOW - d * DAY);
    expect(formatRelativeLastSeen(null, now)).toBe("-");
    expect(formatRelativeLastSeen(now, now)).toBe("today");
    expect(formatRelativeLastSeen(ago(1), now)).toBe("yesterday");
    expect(formatRelativeLastSeen(ago(29), now)).toBe("29d ago");
    expect(formatRelativeLastSeen(ago(30), now)).toBe("1mo ago");
    expect(formatRelativeLastSeen(ago(59), now)).toBe("1mo ago");
    expect(formatRelativeLastSeen(ago(60), now)).toBe("2mo ago");
  });
});

describe("J30 customers: pagination", () => {
  function pager(html: string): string {
    return html.match(/<nav class="cap-pagination"[\s\S]*?<\/nav>/)?.[0] ?? "";
  }

  it("is Recova's arrangement: Page N of M first, then Previous and Next together", () => {
    const nav = pager(render({ page: 2, totalPages: 3, totalCount: 120 }));
    expect(nav).toContain('aria-label="Customer pages"');
    expect(nav).toMatch(/<p class="cap-pagination-status">Page 2 of 3<\/p>\s*<ul class="cap-pagination-list">/);
    expect(nav).toMatch(/data-kind="prev"[^>]*href="\/intelligence\/customers"[^>]*>Previous<\/a>/);
    expect(nav).toMatch(/data-kind="next"[^>]*href="\/intelligence\/customers\?page=3"[^>]*>Next<\/a>/);
    expect(nav.indexOf("Previous")).toBeLessThan(nav.indexOf("Next"));
  });

  it("shows only the ends that lead somewhere, as Recova does", () => {
    const first = pager(render({ page: 1, totalPages: 3, totalCount: 120 }));
    expect(first).not.toContain("Previous");
    expect(first).toContain("Next");
    const last = pager(render({ page: 3, totalPages: 3, totalCount: 120 }));
    expect(last).toContain("Previous");
    expect(last).not.toContain("Next");
  });

  it("keeps the filters when paging", () => {
    const nav = pager(
      render({ page: 1, totalPages: 2, totalCount: 60, filters: { ...NO_FILTERS, tier: "growth", sort: "mrr_desc" } }),
    );
    expect(nav).toContain('href="/intelligence/customers?tier=growth&amp;sort=mrr_desc&amp;page=2"');
  });

  it("renders no pager for a single page", () => {
    expect(pager(render())).toBe("");
  });
});

describe("J30 customers: the approved filter bar, on Capsomer's parts", () => {
  it("uses Capsomer's field labels, inputs, selects and primary button", () => {
    const html = render();
    expect(html).toMatch(/<label class="cap-field-label" for="customers-q">Name or email<\/label>/);
    expect(html).toMatch(/<input class="cap-input" id="customers-q"/);
    expect(html).toMatch(/<select class="cap-select" id="customers-tier" name="tier"/);
    expect(html).toMatch(/<select class="cap-select" id="customers-band" name="band"/);
    expect(html).toMatch(/<select class="cap-select" id="customers-sort" name="sort"/);
    expect(html).toMatch(/<button[^>]*class="cap-btn"[^>]*data-variant="primary"[^>]*>Filter<\/button>/);
  });
});

describe("J30 customers: source", () => {
  it("takes its parts from Capsomer and keeps no local copy of a shared one", () => {
    expect(SOURCE).toContain('from "capsomer/react/page-head"');
    expect(SOURCE).toContain('import "capsomer/table.css"');
    expect(SOURCE).not.toContain("~/components/badge");
    expect(SOURCE).not.toContain("rounded-[12px]");
  });

  it("carries no amber and no arbitrary text size", () => {
    expect(SOURCE).not.toMatch(/amber/i);
    expect(SOURCE).not.toMatch(/text-\[/);
  });
});
