import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { RESOLVED_DISPUTE_STATES, isDisputeResolved } from "~/lib/disputes/labels";

// RULING 304: the section reorder (closing 295 Q1) and the open-dispute badge
// (closing 295 Q2), both read from legacy PaymentDetailClient.tsx at blob
// 7f54aa45 rather than from the scope doc's summary.
//
// Legacy's section sequence, from the blob's own comment markers:
//   229 back+header, 273 intelligence banner, 276 ACTION RESULT BANNER,
//   289 ACTION BUTTONS, 329 stripe links, 362 top info cards,
//   370 details+engagement, 423 timeline, 573 internal notes,
//   599 RECOVERY SUCCESS BANNER (last).
//
// After 304's normalization commit the tree is LF, so no CRLF handling here.

const ROUTE = readFileSync("app/routes/app/recovery/payments/detail.tsx", "utf8");
const QUERIES = readFileSync("app/lib/recovery/queries.server.ts", "utf8");

/** Comments stripped. Both files NAME the identifiers they deliberately no
 *  longer use, so a bare search for a removed symbol matches the explanation
 *  rather than the code. Caught by the first run of this file. */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const ROUTE_CODE = strip(ROUTE);
const QUERIES_CODE = strip(QUERIES);

/** Index of a section's anchor, asserted present so an ordering comparison can
 *  never silently pass on two -1s. */
function at(needle: string): number {
  const i = ROUTE.indexOf(needle);
  expect(i, `section anchor missing: ${needle}`).toBeGreaterThan(-1);
  return i;
}

const SECTIONS = {
  header: () => at("{failedPayment.customerName ?? failedPayment.customerEmail}"),
  resultBanner: () => at('{actionData && "error" in actionData ? ('),
  actionRow: () => at(">Manual actions</p>"),
  stripeLinks: () => at("Legacy's two Stripe deep links"),
  statCards: () => at('<StatCard label="Amount"'),
  engagement: () => at(">Email engagement</p>"),
  outcome: () => at(">Outcome</p>"),
  timeline: () => at(">Recovery timeline</p>"),
  notes: () => at(">Internal notes</p>"),
  successBanner: () => at('failedPayment.status === "recovered" && recovery ?'),
};

describe("304 build 1: the page is in legacy's section ORDER", () => {
  it("the whole sequence matches legacy's, section by section", () => {
    // Ordering, not presence. Each pair is a distinct claim about sequence, so a
    // partial reorder fails here rather than passing on "everything renders".
    const order = [
      SECTIONS.header(),
      SECTIONS.resultBanner(),
      SECTIONS.actionRow(),
      SECTIONS.stripeLinks(),
      SECTIONS.statCards(),
      SECTIONS.engagement(),
      SECTIONS.outcome(),
      SECTIONS.timeline(),
      SECTIONS.notes(),
      SECTIONS.successBanner(),
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("THE MOVE: the action row sits ABOVE the Stripe links, as legacy's does", () => {
    // This is the load-bearing assertion. Before 304 the action row was the
    // second-to-last block on the page, below even the timeline.
    expect(SECTIONS.actionRow()).toBeLessThan(SECTIONS.stripeLinks());
    expect(SECTIONS.actionRow()).toBeLessThan(SECTIONS.timeline());
    expect(SECTIONS.actionRow()).toBeLessThan(SECTIONS.notes());
  });

  it("the result banner precedes the buttons it reports on, as legacy orders them", () => {
    expect(SECTIONS.resultBanner()).toBeLessThan(SECTIONS.actionRow());
  });

  it("REGRESSION GUARD: the success banner is still LAST", () => {
    // Session 15 placed it last precisely because that survives this ruling.
    // If the reorder had swept it up with the action row, this fails.
    const others = Object.entries(SECTIONS)
      .filter(([k]) => k !== "successBanner")
      .map(([, f]) => f());
    expect(SECTIONS.successBanner()).toBeGreaterThan(Math.max(...others));
  });

  it("REGRESSION GUARD: the Outcome card keeps its ratified slot", () => {
    // 251 and 254 ratified it where it sits. Legacy has no counterpart, so there
    // was no legacy position to move it to and it must not have drifted.
    expect(SECTIONS.outcome()).toBeGreaterThan(SECTIONS.engagement());
    expect(SECTIONS.outcome()).toBeLessThan(SECTIONS.timeline());
  });
});

describe("304 build 2: the open-dispute badge", () => {
  it("renders on the dispute predicate ALONE, with no entitlement read", () => {
    expect(ROUTE).toContain("{openDisputes.length > 0 ? (");
    // The half 304 removed. account_products is gone (298) and no revived
    // entitlement flag may gate this badge.
    expect(ROUTE_CODE).not.toContain("disputesActive");
    expect(ROUTE_CODE).not.toContain("accountProducts");
    expect(QUERIES_CODE).not.toContain("accountProducts");
  });

  it("the loader DERIVES open from the shared constant, never a restated list", () => {
    // Deriving is what keeps the SQL and isDisputeResolved from drifting. A
    // hand-written state list in the query would pass a presence check and rot.
    expect(QUERIES_CODE).toContain("notInArray(disputes.state, [...RESOLVED_DISPUTE_STATES])");
    expect(QUERIES_CODE).not.toContain('"resolved_won"');
    expect(QUERIES_CODE).not.toContain('"resolved_lost"');
  });

  it("BEHAVIOUR: the constant and the helper agree on what open means", () => {
    // Not source text. If a state joins RESOLVED_DISPUTE_STATES, both the query
    // and the helper move together, and this proves they still agree.
    for (const s of RESOLVED_DISPUTE_STATES) expect(isDisputeResolved(s)).toBe(true);
    for (const s of ["draft", "pending_review", "approved", "submitted"]) {
      expect(isDisputeResolved(s)).toBe(false);
    }
    expect(RESOLVED_DISPUTE_STATES.length).toBeGreaterThan(0);
  });

  it("carries legacy's singular and plural copy and links to the dispute", () => {
    expect(ROUTE).toContain('openDisputes.length === 1 ? "1 open dispute"');
    expect(ROUTE).toContain("open disputes");
    expect(ROUTE).toContain("to={`/disputes/${openDisputes[0].id}`}");
  });

  it("sits in the header beside the title, which is legacy's placement", () => {
    const title = SECTIONS.header();
    const badge = at("{openDisputes.length > 0 ? (");
    const emailLine = at("{failedPayment.customerEmail}");
    expect(badge).toBeGreaterThan(title);
    expect(badge).toBeLessThan(emailLine);
  });

  it("REGRESSION GUARD: the title still falls back from name to email", () => {
    // The badge edit rewrapped the h1. If the fallback were lost, a nameless
    // payment would render an empty title beside a dispute badge.
    expect(ROUTE).toContain("{failedPayment.customerName ?? failedPayment.customerEmail}");
  });
});
