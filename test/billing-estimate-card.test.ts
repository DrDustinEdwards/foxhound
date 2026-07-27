import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BillingEstimateCard } from "~/components/billing-estimate-card";
import type { BillingPreview } from "~/lib/billing/preview.server";

// The forward-looking card on /billing. What it renders is a claim to a
// merchant about money they are about to be charged, so the states are tested
// as copy, not just as data: an empty estimate on an exempt or paused account
// is NOT the same claim as nothing owed, and rendering the second when the
// first is true would be a lie the merchant has no way to catch.

const NEXT_RUN_MS = new Date("2026-08-01T04:00:00.000Z").getTime();

// Built from char codes rather than written literally, so this file (which
// exists to enforce the no-wide-dash rule) does not itself contain the
// characters it forbids. Canon allows a literal only as a \uXXXX escape; a
// constant is the same idea and survives a copy through a shell intact.
const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);

const preview = (over: Partial<BillingPreview> = {}): BillingPreview => ({
  recoveredThisMonth: [{ currency: "usd", cents: 35_000 }],
  nextRunAtMs: NEXT_RUN_MS,
  estimatedInvoice: [{ currency: "usd", cents: 29_600 }],
  accountBillingState: { billingExempt: false, processingPaused: false, cancelledAt: null },
  ...over,
});

const render = (p: BillingPreview): string =>
  renderToStaticMarkup(createElement(BillingEstimateCard, { preview: p }));

describe("BillingEstimateCard", () => {
  it("shows recovered this month, the estimated fee, and the next invoice date", () => {
    const html = render(preview());
    expect(html).toContain("Recovered this month");
    expect(html).toContain("$350.00");
    expect(html).toContain("Estimated fee");
    expect(html).toContain("$296.00");
    // Formatted in UTC: the run instant is 04:00 UTC, and rendering it in a
    // local zone would show the previous day for anyone west of London.
    expect(html).toContain("Aug 1, 2026");
  });

  it("labels the number an estimate and says the invoice is the record", () => {
    expect(render(preview())).toContain(
      "Estimate. Refunds or disputes before the run reduce it; the invoice is the record.",
    );
  });

  it("renders one row per currency, matching how the run invoices", () => {
    const html = render(
      preview({
        recoveredThisMonth: [
          { currency: "usd", cents: 35_000 },
          { currency: "eur", cents: 20_000 },
        ],
        estimatedInvoice: [
          { currency: "usd", cents: 29_600 },
          { currency: "eur", cents: 4_000 },
        ],
      }),
    );
    expect(html).toContain("$296.00");
    expect(html).toContain("40.00");
    expect(html).toContain("200.00");
  });

  describe("states where an empty estimate would be a lie", () => {
    it("says billing exempt instead of showing a zero estimate", () => {
      const html = render(
        preview({
          estimatedInvoice: [],
          accountBillingState: {
            billingExempt: true,
            processingPaused: false,
            cancelledAt: null,
          },
        }),
      );
      expect(html).toContain("Billing exempt");
      expect(html).not.toContain("Nothing is due");
      expect(html).not.toContain("$0.00");
    });

    it("says processing is paused instead of showing a zero estimate", () => {
      const html = render(
        preview({
          estimatedInvoice: [],
          accountBillingState: {
            billingExempt: false,
            processingPaused: true,
            cancelledAt: null,
          },
        }),
      );
      expect(html).toContain("Processing is paused");
      expect(html).not.toContain("Nothing is due");
      expect(html).not.toContain("$0.00");
    });

    it("prefers the exempt state when an account is both exempt and paused", () => {
      const html = render(
        preview({
          estimatedInvoice: [],
          accountBillingState: { billingExempt: true, processingPaused: true, cancelledAt: null },
        }),
      );
      expect(html).toContain("Billing exempt");
      expect(html).not.toContain("Processing is paused");
    });
  });

  it("still shows the estimate for a cancelled account, and says it is cancelled", () => {
    // cancelled_at is a PROCESSING gate, never a billing gate: the billable
    // queries ignore it on purpose, so a cancelled merchant is still invoiced
    // for fees already earned. Hiding the estimate here would tell them the
    // opposite of what the run is about to do.
    const html = render(
      preview({
        accountBillingState: {
          billingExempt: false,
          processingPaused: false,
          cancelledAt: new Date("2026-07-09T00:00:00.000Z"),
        },
      }),
    );
    expect(html).toContain("$296.00");
    expect(html).toContain("cancelled");
  });

  describe("honest empty state", () => {
    it("says nothing is due when a billing-eligible account owes nothing", () => {
      const html = render(preview({ estimatedInvoice: [] }));
      expect(html).toContain("Nothing is due");
      expect(html).not.toContain("$0.00");
      expect(html).not.toContain("Billing exempt");
      expect(html).not.toContain("Processing is paused");
    });

    it("still shows the recovered revenue and the date when nothing is due", () => {
      const html = render(preview({ estimatedInvoice: [] }));
      expect(html).toContain("$350.00");
      expect(html).toContain("Aug 1, 2026");
    });

    it("shows no recovered revenue rather than a zero when there is none", () => {
      const html = render(preview({ recoveredThisMonth: [], estimatedInvoice: [] }));
      expect(html).not.toContain("$0.00");
      expect(html).toContain("Nothing is due");
    });
  });

  describe("copy rules", () => {
    // PRICING.md governs where rates may appear. This card renders the
    // merchant's own computed amounts, which is allowed, but the rate itself
    // is pricing copy and does not belong on an in-app billing surface.
    it("carries no percentage or rate language in any state", () => {
      const states: BillingPreview[] = [
        preview(),
        preview({ estimatedInvoice: [] }),
        preview({
          estimatedInvoice: [],
          accountBillingState: { billingExempt: true, processingPaused: false, cancelledAt: null },
        }),
        preview({
          estimatedInvoice: [],
          accountBillingState: { billingExempt: false, processingPaused: true, cancelledAt: null },
        }),
      ];
      for (const state of states) {
        const html = render(state);
        expect(html).not.toContain("%");
        expect(html).not.toMatch(/\bpercent/i);
        expect(html).not.toMatch(/\b20\s*%/);
      }
    });

    it("carries no em dash or en dash in any state", () => {
      const states: BillingPreview[] = [
        preview(),
        preview({ estimatedInvoice: [] }),
        preview({
          estimatedInvoice: [],
          accountBillingState: { billingExempt: true, processingPaused: false, cancelledAt: null },
        }),
      ];
      for (const state of states) {
        const html = render(state);
        // Written as escapes, not literals: canon keeps the source file itself
        // free of wide dashes so a repo-wide grep for one stays meaningful.
        expect(html).not.toContain(EM_DASH);
        expect(html).not.toContain(EN_DASH);
      }
    });
  });
});
