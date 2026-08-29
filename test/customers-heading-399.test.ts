import { readFileSync } from "node:fs";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { describe, expect, it } from "vitest";

import IntelligenceCustomersPage from "~/routes/app/intelligence/customers";

// Ruling 399, session 90 job 7 (the H1 half). The 394 walk never saw legacy's
// real heading because it compared against the demo twin. Legacy's real page,
// app/(app)/intelligence/customers/page.tsx:74:
//
//   const accountName = membership.account.name ?? 'Customers'
//   <h1 className="m-0 text-2xl font-semibold text-text">{accountName} customers</h1>
//
// THE CHIP HALF OF JOB 7 IS HALTED, NOT SHIPPED, and this file records why so
// the next session does not read the missing chip as an oversight. Legacy's chip
// renders `c.health_factors?.recommended_action` through its own chipLabelFor
// map (same file, lines 34-45). Nothing in Foxhound writes
// `recommended_action`: app/lib/constants.ts:384 says so of
// WINBACK_PRIORITY_ACTION ("It has NO producer in Foxhound today"),
// app/lib/dashboard/console.server.ts:179 and app/lib/recovery/digest-email.ts:141
// each say so independently, and all three name it as the same blocker that
// holds /intelligence/recommendations (row S20). The only rows carrying the
// field are demo seed rows, whose vocabulary does not even match legacy's map,
// so a chip would be blank for every real customer and wrong for the demo ones.
//
// TYPE IS UNTOUCHED. Legacy is 24px/600 and Foxhound is 20px/500; the walk
// recorded that pair as FROZEN under 179/187, which freezes in both directions.
// Only the words change.

const SOURCE = readFileSync(
  new URL("../app/routes/app/intelligence/customers.tsx", import.meta.url),
  "utf8",
);

const Page = IntelligenceCustomersPage as unknown as (props: {
  loaderData: Record<string, unknown>;
}) => ReactElement;

// The page renders a <Form>, which needs a data router rather than a plain
// MemoryRouter; createRoutesStub supplies one and lets the loader data be
// injected directly.
function render(accountName: string | null): string {
  const Stub = createRoutesStub([
    {
      path: "/",
      Component: () => createElement(Page, { loaderData: loaderData(accountName) }),
    },
  ]);
  return renderToStaticMarkup(createElement(Stub));
}

function loaderData(accountName: string | null): Record<string, unknown> {
  return {
    entitled: true,
    result: { customers: [], totalCount: 0, totalMrrCents: 0, page: 1, totalPages: 1 },
    tiers: [],
    filters: { search: "", tier: "", healthBand: "", sort: "health_asc" },
    accountName,
    nowMs: Date.UTC(2026, 7, 29),
  };
}

describe("S17 customers heading", () => {
  it("is the account's name followed by customers, as legacy's is", () => {
    expect(render("Acme")).toContain("Acme customers");
  });

  it("names whichever account is active, which is what multi-account made it for", () => {
    expect(render("Bolt Analytics")).toContain("Bolt Analytics customers");
    expect(render("Bolt Analytics")).not.toContain("Acme customers");
  });

  it("does not render legacy's doubled fallback when the account has no name", () => {
    // Legacy's `name ?? 'Customers'` produces the H1 "Customers customers".
    // Raised as a ruling-39-class legacy defect rather than reproduced.
    const html = render(null);
    expect(html).not.toMatch(/Customers customers/i);
    expect(html).toContain("Customers");
  });

  it("keeps Foxhound's frozen heading type", () => {
    // 179/187 freeze the type scale in both directions, so the port changes the
    // words and not the size. A later reader "restoring" legacy's 24px/600 here
    // would be unfreezing by accident.
    expect(SOURCE).toContain('<h1 className="text-title font-medium text-text">{heading}</h1>');
  });
});

describe("S17 recommended-action chip: HALTED, and the halt is guarded", () => {
  it("renders no chip, because nothing in Foxhound produces a recommendation", () => {
    // If a later session wires a chip, this assertion is what should make them
    // prove a producer exists first. The three source comments cited in this
    // file's header are the evidence that none does today.
    const html = render("Acme");
    for (const label of [
      "Outreach",
      "Win-back",
      "Accept dispute",
      "Watch closely",
      "Low yield",
      "Expansion",
      "Automated",
    ]) {
      expect(html).not.toContain(">" + label + "<");
    }
  });

  it("still has no writer for recommended_action anywhere outside the demo seed", () => {
    // The halt's premise, asserted rather than asserted-in-prose, so it fails
    // the day it stops being true and the chip becomes buildable.
    const writers = [
      "app/lib/intelligence/ai-run.server.ts",
      "app/lib/intelligence/signals.ts",
      "app/lib/intelligence/sync.server.ts",
      "app/lib/intelligence/risk.ts",
    ]
      .map((p) => {
        try {
          return readFileSync(new URL("../" + p, import.meta.url), "utf8");
        } catch {
          return "";
        }
      })
      .join("\n");
    expect(writers.length).toBeGreaterThan(1000);
    expect(writers).not.toMatch(/recommended_action|recommendedAction/);
  });
});
