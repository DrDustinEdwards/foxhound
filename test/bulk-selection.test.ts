import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  actionableSelection,
  allVisibleSelected,
  selectedCount,
  toggleAllVisible,
  toggleOne,
  visibleSelection,
  type SelectableRow,
} from "~/lib/recovery/bulk-selection";

// S6 bulk selection, Session 1 (274). The selection layer only: no POST target,
// no mutation, no dispatcher change.
//
// The property under test is 274 decision three, that the selection prunes to
// the visible set on every filter change, and the reason it is testable as a
// PURE unit is that the model derives the effective selection on read instead of
// mutating state on change. Legacy's defect (scope 1.3 and 1.4, GATE-VERSUS-
// SUBMIT) is that its count and its request set are different sets; here they
// are the same set by construction, which is what these assertions pin.

const LIST_ROUTE = readFileSync("app/routes/app/recovery/payments/index.tsx", "utf8");

const rows = (...spec: [string, string][]): SelectableRow[] =>
  spec.map(([id, status]) => ({ id, status }));

const PAGE: SelectableRow[] = rows(
  ["p1", "active"],
  ["p2", "recovered"],
  ["p3", "active"],
  ["p4", "cancelled"],
);

describe("bulk selection: the effective selection is pruned to what is on screen", () => {
  it("drops ids that are no longer visible, which is 274 decision three", () => {
    // The exact legacy scenario: five selected, then a filter narrows the page
    // to two of them. Legacy would still submit all five (scope 1.3).
    const selected = new Set(["p1", "p2", "p3", "gone_a", "gone_b"]);
    const narrowed = rows(["p1", "active"], ["p2", "recovered"]);

    expect(visibleSelection(selected, narrowed)).toEqual(["p1", "p2"]);
    expect(selectedCount(selected, narrowed)).toBe(2);
  });

  it("returns ids in ROW order, not insertion order, so output is deterministic", () => {
    const selected = new Set(["p3", "p1"]);
    expect(visibleSelection(selected, PAGE)).toEqual(["p1", "p3"]);
  });

  it("an emptied page selects nothing, however much state survives", () => {
    const selected = new Set(["p1", "p2", "p3"]);
    expect(visibleSelection(selected, [])).toEqual([]);
    expect(selectedCount(selected, [])).toBe(0);
  });
});

describe("bulk selection: the actionable subset is the ONLY set an action may use", () => {
  it("is selected AND visible AND active, all three", () => {
    const selected = new Set(["p1", "p2", "p4", "off_page"]);
    // p1 active and selected -> in. p2 recovered -> out. p4 cancelled -> out.
    // p3 active but NOT selected -> out. off_page not visible -> out.
    expect(actionableSelection(selected, PAGE)).toEqual(["p1"]);
  });

  it("COUNT AND REQUEST ARE ONE SET, which is the gate-versus-submit repair", () => {
    // Legacy's bar would label this "Trigger next step (2)" and then submit 4.
    // Here the label reads actionableSelection and so must the request, so the
    // number a merchant sees is the number of payments that can be touched.
    const selected = new Set(["p1", "p2", "p3", "p4"]);
    const actionable = actionableSelection(selected, PAGE);
    expect(actionable).toEqual(["p1", "p3"]);
    expect(actionable.length).toBe(2);
    // And the whole selection is strictly larger, which is the trap being closed.
    expect(selectedCount(selected, PAGE)).toBe(4);
  });

  it("is empty when nothing selected is active, so the bar withholds its actions", () => {
    expect(actionableSelection(new Set(["p2", "p4"]), PAGE)).toEqual([]);
  });
});

describe("bulk selection: select-all is page-scoped (274 decision four)", () => {
  it("selects exactly the visible page, replacing any off-page state", () => {
    const selected = new Set(["off_page_1", "off_page_2"]);
    const next = toggleAllVisible(selected, PAGE);
    expect([...next].sort()).toEqual(["p1", "p2", "p3", "p4"]);
    expect(next.has("off_page_1")).toBe(false);
  });

  it("toggling off clears everything", () => {
    const all = new Set(["p1", "p2", "p3", "p4"]);
    expect(allVisibleSelected(all, PAGE)).toBe(true);
    expect([...toggleAllVisible(all, PAGE)]).toEqual([]);
  });

  it("an EMPTY page is not 'all selected', so the header box is unchecked", () => {
    // Otherwise a page with nothing on it would render a checked select-all.
    expect(allVisibleSelected(new Set(), [])).toBe(false);
    expect(allVisibleSelected(new Set(["x"]), [])).toBe(false);
  });

  it("partial selection is not 'all selected'", () => {
    expect(allVisibleSelected(new Set(["p1"]), PAGE)).toBe(false);
  });
});

describe("bulk selection: toggling one row", () => {
  it("adds and removes without disturbing the rest, and never mutates its input", () => {
    const selected: ReadonlySet<string> = new Set(["p1"]);
    const added = toggleOne(selected, "p3");
    expect([...added].sort()).toEqual(["p1", "p3"]);
    const removed = toggleOne(added, "p1");
    expect([...removed]).toEqual(["p3"]);
    // The original set is untouched: React state must not be mutated in place.
    expect([...selected]).toEqual(["p1"]);
  });
});

describe("bulk selection: the demo renders NO checkbox, and non-demo renders them", () => {
  // Both sides asserted per 255: testing only the demo side could not tell a
  // working gate apart from a column that does not exist at all.
  it("gates BOTH the select-all header and the per-row box on !isDemo", () => {
    expect(LIST_ROUTE).toContain("{!isDemo ? (");
    expect(LIST_ROUTE).toContain('aria-label="Select all payments"');
    // Two checkboxes, header and row, and both inside a !isDemo branch.
    expect(LIST_ROUTE.match(/type="checkbox"/g)).toHaveLength(2);
    expect(LIST_ROUTE.match(/\{!isDemo \? \(/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("reads isDemo the way the existing surface does, off the app-shell loader", () => {
    // Matching DemoGuardedForm rather than inventing a second source of truth.
    expect(LIST_ROUTE).toContain('useRouteLoaderData<typeof appShellLoader>("app-shell")');
    expect(LIST_ROUTE).toContain("const isDemo = Boolean(shell?.isDemo);");
  });

  it("withholds the whole bulk bar in demo as legacy does", () => {
    expect(LIST_ROUTE).toContain("{!isDemo && selectionCount > 0 ? (");
  });

  it("grows the empty-state colspan with the column, or the row would misalign", () => {
    expect(LIST_ROUTE).toContain("colSpan={isDemo ? 6 : 7}");
  });
});

describe("bulk selection: Session 1 wires NO mutation", () => {
  it("the three bulk buttons carry no handler and are disabled", () => {
    // Slice the ACTIONABLE block precisely. An earlier version of this matcher
    // sliced up to the literal "Clear" and swept in the Clear button's own
    // onClick, which sits before its label in source: the matcher was wrong, not
    // the code (239). Bounded here by the block's own opening and closing.
    const bar = LIST_ROUTE.slice(LIST_ROUTE.indexOf('aria-label="Bulk actions"'));
    const start = bar.indexOf("{actionable.length > 0 ? (");
    const end = bar.indexOf(") : null}", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const actionableBlock = bar.slice(start, end);
    // Three action buttons, each disabled, none carrying an onClick. The
    // negative lookahead excludes the `disabled:opacity-60` Tailwind class,
    // which a bare \bdisabled\b counted as a fourth, fifth and sixth attribute.
    expect(actionableBlock.match(/disabled(?!:)/g)).toHaveLength(3);
    expect(actionableBlock).not.toContain("onClick");
  });

  it("Clear IS wired, because clearing selection mutates nothing", () => {
    expect(LIST_ROUTE).toContain("onClick={() => setSelected(new Set())}");
  });

  it("legacy's three labels in legacy's order, with Stop recovery per 251", () => {
    const bar = LIST_ROUTE.slice(LIST_ROUTE.indexOf('aria-label="Bulk actions"'));
    const trigger = bar.indexOf("Trigger next step");
    const recovered = bar.indexOf("Mark recovered");
    const stop = bar.indexOf("Stop recovery");
    expect(trigger).toBeGreaterThan(-1);
    expect(recovered).toBeGreaterThan(trigger);
    expect(stop).toBeGreaterThan(recovered);
    // 251 ratified "Stop recovery" for this subject on BOTH sides, so legacy's
    // own "Cancel recovery" wording is NOT reintroduced here.
    expect(bar).not.toContain("Cancel recovery");
  });
});
