import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { describe, expect, it } from "vitest";

import type { BillingPreview } from "~/lib/billing/preview.server";
import type { BillingInvoiceRow, EnrichedLineItem } from "~/lib/billing/queries.server";

// J65, row S3: /billing in Recova's sections on Foxhound's billing engine.
//
// Recova is the spec (app/(app)/billing/page.tsx at blob 34e56833 and its four
// section components): Recovery, Dispute Fees, the Intelligence offer,
// Subscriptions and Payment method, in that order, in a 720px column. What the
// sections SAY is pinned here as copy, because every line is a claim to a
// merchant about money, and the places Recova's copy would be false of
// Foxhound's engine are pinned as the truthful version.

const { buildRecoveryHistory, buildDisputeFeeRows, BILLING_HISTORY_LIMIT } = await import(
  "~/lib/billing/page.server"
);
const { ordinal, subscriptionDetail } = await import("~/lib/billing/page");
const BillingRoute = (await import("~/routes/app/billing/index")).default;

const NEXT_RUN_MS = Date.parse("2026-08-01T04:00:00.000Z");
const T = (iso: string) => new Date(iso);

function invoice(over: Partial<BillingInvoiceRow> & { id: string }): BillingInvoiceRow {
  return {
    accountId: "acct_1",
    currency: "usd",
    periodStart: T("2026-06-01T00:00:00.000Z"),
    periodEnd: T("2026-07-01T00:00:00.000Z"),
    status: "paid",
    totalCents: 0,
    stripeInvoiceId: null,
    stripeInvoiceUrl: null,
    idempotencyKey: `key_${over.id}`,
    createdAt: T("2026-07-01T04:00:00.000Z"),
    finalizedAt: null,
    chargeAttemptCount: 0,
    lastChargeAttemptAt: null,
    ...over,
  } as BillingInvoiceRow;
}

function recoveryLine(id: string, invoiceId: string, recoveredCents: number, feeCents: number): EnrichedLineItem {
  return {
    lineItem: {
      id,
      invoiceId,
      accountId: "acct_1",
      type: "recovery_fee",
      currency: "usd",
      amountCents: feeCents,
      feeCents,
      recoveredPaymentId: `rp_${id}`,
      disputeId: null,
      adminAuditLogId: null,
      description: null,
      createdAt: T("2026-07-01T04:00:00.000Z"),
      stripeCreditNoteId: null,
      creditsLineItemId: null,
    },
    recoveredPayment: {
      id: `rp_${id}`,
      accountId: "acct_1",
      failedPaymentId: `fp_${id}`,
      recoveredAt: T("2026-06-10T00:00:00.000Z"),
      amountCents: recoveredCents,
      currency: "usd",
      attributionKind: "foxhound_retry",
    },
    creditedStepType: null,
    dispute: null,
    adminAuditEntry: null,
  } as unknown as EnrichedLineItem;
}

function disputeLine(
  id: string,
  invoiceId: string,
  disputeCents: number,
  feeCents: number,
  createdAt = T("2026-07-01T04:00:00.000Z"),
): EnrichedLineItem {
  return {
    lineItem: {
      id,
      invoiceId,
      accountId: "acct_1",
      type: "dispute_fee",
      currency: "usd",
      amountCents: feeCents,
      feeCents,
      recoveredPaymentId: null,
      disputeId: `dsp_${id}`,
      adminAuditLogId: null,
      description: null,
      createdAt,
      stripeCreditNoteId: null,
      creditsLineItemId: null,
    },
    recoveredPayment: null,
    creditedStepType: null,
    dispute: { id: `dsp_${id}`, amountCents: disputeCents, currency: "usd" },
    adminAuditEntry: null,
  } as unknown as EnrichedLineItem;
}

describe("ordinal (Recova's 'Invoiced on the 1st', from the run's day of month)", () => {
  it("says 1st, 2nd, 3rd, 4th, 11th, 12th, 13th, 21st", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21].map(ordinal)).toEqual([
      "1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st",
    ]);
  });
});

describe("buildRecoveryHistory (Recova's assessment rows, from Foxhound's invoices)", () => {
  const invoices = [
    invoice({
      id: "inv_june",
      periodStart: T("2026-06-01T00:00:00.000Z"),
      status: "paid",
      stripeInvoiceId: "in_123",
      stripeInvoiceUrl: "https://invoice.stripe.com/i/123",
    }),
    invoice({ id: "inv_disputes_only", periodStart: T("2026-05-01T00:00:00.000Z"), status: "finalized" }),
  ];
  const lines = [
    recoveryLine("l1", "inv_june", 10_000, 2_000),
    recoveryLine("l2", "inv_june", 5_000, 1_000),
    disputeLine("l3", "inv_june", 50_000, 10_000),
    disputeLine("l4", "inv_disputes_only", 20_000, 4_000),
  ];

  it("gives one row per invoice that billed a recovery, with the recovered amount and the recovery fee only", () => {
    const rows = buildRecoveryHistory(invoices, lines);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      invoiceId: "inv_june",
      periodLabel: "June 2026",
      currency: "usd",
      recoveredCents: 15_000,
      feeCents: 3_000,
      statusLabel: "Paid",
      statusTone: "ok",
      invoiceUrl: "https://invoice.stripe.com/i/123",
      stripeInvoiceId: "in_123",
    });
  });

  it("is newest period first and keeps Recova's twelve", () => {
    const many = Array.from({ length: BILLING_HISTORY_LIMIT + 2 }, (_, i) =>
      invoice({ id: `inv_${i}`, periodStart: T(new Date(Date.UTC(2025, i, 1)).toISOString()) }),
    );
    const manyLines = many.map((inv, i) => recoveryLine(`m${i}`, inv.id, 1_000, 200));
    const rows = buildRecoveryHistory(many, manyLines);
    expect(rows).toHaveLength(12);
    expect(rows[0]!.periodLabel).toBe("February 2026");
    expect(rows[11]!.periodLabel).toBe("March 2025");
  });

  it("labels a status the merchant can read, never the raw value", () => {
    const rows = buildRecoveryHistory(
      [invoice({ id: "inv_g", status: "gave_up" })],
      [recoveryLine("g1", "inv_g", 1_000, 200)],
    );
    expect(rows[0]).toMatchObject({ statusLabel: "Not collected", statusTone: "crit" });
  });
});

describe("buildDisputeFeeRows (Recova's dispute fee rows, from billed lines and next run's pending fees)", () => {
  const invoices = [invoice({ id: "inv_1", status: "paid", stripeInvoiceUrl: "https://invoice.stripe.com/i/1" })];

  it("lists a fee the next run will bill as Pending, before the billed ones", () => {
    const rows = buildDisputeFeeRows(invoices, [disputeLine("d1", "inv_1", 50_000, 10_000)], [
      {
        disputeId: "dsp_pending",
        amountCents: 30_000,
        currency: "usd",
        feeCents: 6_000,
        resolvedAt: T("2026-07-10T00:00:00.000Z"),
      },
    ]);
    expect(rows.map((r) => r.statusLabel)).toEqual(["Pending", "Paid"]);
    expect(rows[0]).toMatchObject({ disputeId: "dsp_pending", disputeAmountCents: 30_000, feeCents: 6_000, invoiceUrl: null });
    expect(rows[1]).toMatchObject({
      disputeId: "dsp_d1",
      disputeAmountCents: 50_000,
      feeCents: 10_000,
      invoiceUrl: "https://invoice.stripe.com/i/1",
      statusTone: "ok",
    });
  });

  it("marks a fee the $500 cap held below 20% as capped, and an ordinary one as not", () => {
    const rows = buildDisputeFeeRows(
      invoices,
      [disputeLine("big", "inv_1", 1_000_000, 50_000), disputeLine("small", "inv_1", 50_000, 10_000)],
      [],
    );
    const byId = Object.fromEntries(rows.map((r) => [r.disputeId, r.feeCapped]));
    expect(byId).toEqual({ dsp_big: true, dsp_small: false });
  });

  it("keeps Recova's twelve", () => {
    const lines = Array.from({ length: 15 }, (_, i) =>
      disputeLine(`n${i}`, "inv_1", 10_000, 2_000, new Date(Date.UTC(2026, 0, i + 1))),
    );
    expect(buildDisputeFeeRows(invoices, lines, [])).toHaveLength(12);
  });
});

describe("subscriptionDetail (Recova's Renews, Cancels on, Expired lines)", () => {
  const end = T("2026-09-01T00:00:00.000Z");
  it("an active subscription with a period end renews", () => {
    expect(subscriptionDetail({ status: "active", canceledAt: null, currentPeriodEndsAt: end })).toEqual({
      text: "Renews Sep 1, 2026",
      warn: false,
    });
  });
  it("an active subscription already cancelled cancels on its period end", () => {
    expect(
      subscriptionDetail({ status: "active", canceledAt: T("2026-08-01T00:00:00.000Z"), currentPeriodEndsAt: end }),
    ).toEqual({ text: "Cancels on Sep 1, 2026", warn: true });
  });
  it("a cancelled one with a period end expired", () => {
    expect(subscriptionDetail({ status: "canceled", canceledAt: end, currentPeriodEndsAt: end })).toEqual({
      text: "Expired Sep 1, 2026",
      warn: false,
    });
  });
  it("says nothing without a period end, as Recova does (an admin grant has none)", () => {
    expect(subscriptionDetail({ status: "active", canceledAt: null, currentPeriodEndsAt: null })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The rendered page.

const basePreview = (over: Partial<BillingPreview> = {}): BillingPreview => ({
  recoveredThisMonth: [{ currency: "usd", cents: 35_000 }],
  attributedThisMonth: [{ currency: "usd", cents: 29_000 }],
  nextRunAtMs: NEXT_RUN_MS,
  estimatedInvoice: [{ currency: "usd", cents: 29_600 }],
  estimatedRecoveryFees: [{ currency: "usd", cents: 4_600 }],
  estimatedDisputeFees: [{ currency: "usd", cents: 25_000 }],
  pendingDisputeFees: [],
  accountBillingState: { billingExempt: false, processingPaused: false, cancelledAt: null },
  ...over,
});

interface LoaderShape {
  card: { brand: string; last4: string; expMonth: number; expYear: number } | null;
  preview: BillingPreview;
  recoveryHistory: ReturnType<typeof buildRecoveryHistory>;
  disputeFees: ReturnType<typeof buildDisputeFeeRows>;
  intelligenceEntitled: boolean;
  subscriptions: {
    id: string;
    product: string;
    status: string;
    currentPeriodEndsAt: Date | null;
    canceledAt: Date | null;
  }[];
  ledger: { lineItems: EnrichedLineItem[]; freeRecoveries: [] };
}

const loaderData = (over: Partial<LoaderShape> = {}): LoaderShape => ({
  card: { brand: "visa", last4: "4242", expMonth: 4, expYear: 2030 },
  preview: basePreview(),
  recoveryHistory: buildRecoveryHistory(
    [invoice({ id: "inv_june", stripeInvoiceUrl: "https://invoice.stripe.com/i/123", stripeInvoiceId: "in_123" })],
    [recoveryLine("l1", "inv_june", 10_000, 2_000)],
  ),
  disputeFees: [],
  intelligenceEntitled: false,
  subscriptions: [],
  ledger: { lineItems: [], freeRecoveries: [] },
  ...over,
});

const Page = BillingRoute as unknown as (props: { loaderData: LoaderShape }) => ReactElement;

function render(data: LoaderShape): string {
  const Stub = createRoutesStub([{ path: "/billing", Component: () => createElement(Page, { loaderData: data }) }]);
  return renderToStaticMarkup(createElement(Stub, { initialEntries: ["/billing"] }));
}

/** renderToStaticMarkup escapes apostrophes; compare against what a reader sees. */
const text = (html: string) => html.replaceAll("&#x27;", "'").replaceAll("&amp;", "&");

const headings = (html: string, level: 1 | 2) =>
  [...html.matchAll(new RegExp(`<h${level}[^>]*>(.*?)</h${level}>`, "g"))].map((m) => m[1]!.replace(/<[^>]+>/g, ""));

describe("/billing renders Recova's page on Foxhound's engine", () => {
  it("heads the page as Recova does, with its subtitle", () => {
    const html = render(loaderData());
    expect(headings(html, 1)).toEqual(["Billing"]);
    expect(html).toContain("Invoices, subscriptions, and payment method.");
  });

  it("keeps Recova's sections in Recova's order, with the evidence ledger after them", () => {
    const html = render(
      loaderData({
        subscriptions: [
          { id: "s1", product: "intelligence", status: "active", currentPeriodEndsAt: null, canceledAt: null },
        ],
      }),
    );
    expect(headings(html, 2)).toEqual([
      "Recovery",
      "Dispute Fees",
      "Intelligence",
      "Subscriptions",
      "Payment method",
      "Evidence ledger",
    ]);
  });

  it("states the recovery rate and the invoice day from the engine's own constants", () => {
    expect(text(render(loaderData()))).toContain("20% of attributed recoveries · Invoiced on the 1st");
  });

  it("shows attributed recoveries this month and the next run's recovery fee, never the whole invoice", () => {
    const html = text(render(loaderData()));
    expect(html).toContain("Recovered this month");
    expect(html).toContain("$290");
    expect(html).toContain("Estimated fee (20%)");
    expect(html).toContain("$46");
    // The whole invoice (recovery plus dispute fees) is NOT the recovery fee.
    expect(html).not.toContain("$296");
    expect(html).toContain("Next invoice: August 1, 2026");
  });

  it("says why the fee is not 20% of this month: maturity, in PRICING's own words", () => {
    expect(text(render(loaderData()))).toContain(
      "We never bill a recovery until you've held the money for 30 days.",
    );
  });

  it("renders a recovery history row with Recova's fields, linked to its invoice", () => {
    const html = text(render(loaderData()));
    expect(html).toContain("June 2026");
    expect(html).toContain("Recovered: $100 · Fee: $20");
    expect(html).toContain('href="/billing/invoices/inv_june"');
    expect(html).toMatch(/<a[^>]*href="https:\/\/invoice\.stripe\.com\/i\/123"[^>]*>View invoice/);
    expect(html).toMatch(/href="https:\/\/invoice\.stripe\.com\/i\/123"[^>]*target="_blank"|target="_blank"[^>]*href="https:\/\/invoice\.stripe\.com\/i\/123"/);
  });

  it("with no history, says when the first invoice comes without promising next month", () => {
    const html = text(render(loaderData({ recoveryHistory: [] })));
    expect(html).toContain("No billing history yet.");
    expect(html).not.toContain("1st of next month");
  });

  it("states the dispute fee with its cap, and the pending total for the next invoice", () => {
    const html = text(render(loaderData()));
    expect(html).toContain(
      "Foxhound charges 20% of disputes we win on your behalf, capped at $500 per dispute, converted at Stripe's rate on the day the dispute resolves.",
    );
    expect(html).toContain("Disputes won by Stripe Smart Disputes or submitted by you are not charged.");
    expect(html).toContain("Pending fees this month");
    expect(html).toContain("$250");
    expect(html).toContain("Added to your next monthly invoice on August 1, 2026.");
    expect(html).toContain("No dispute fees yet.");
  });

  it("renders a dispute fee row as Recova does, naming a capped fee as capped", () => {
    const html = text(
      render(
        loaderData({
          disputeFees: buildDisputeFeeRows(
            [invoice({ id: "inv_1" })],
            [disputeLine("big", "inv_1", 1_000_000, 50_000)],
            [],
          ),
        }),
      ),
    );
    expect(html).toContain("Dispute won: $10,000");
    expect(html).toContain("Fee (capped): $500");
    expect(html).not.toContain("No dispute fees yet.");
  });

  it("offers Intelligence at the engine's price only to an account without it, with no dead button", () => {
    const html = text(render(loaderData()));
    expect(html).toContain("$199/mo, account-wide");
    expect(html).toContain("Subscribing from Foxhound is not built yet.");
    expect(html).not.toContain("Subscribe to Intelligence");
    expect(headings(render(loaderData({ intelligenceEntitled: true })), 2)).not.toContain("Intelligence");
  });

  it("lists subscriptions with a readable status and leaves out cancel and reactivate, which have no writer", () => {
    const html = text(
      render(
        loaderData({
          subscriptions: [
            {
              id: "s1",
              product: "intelligence",
              status: "active",
              currentPeriodEndsAt: T("2026-09-01T00:00:00.000Z"),
              canceledAt: null,
            },
          ],
        }),
      ),
    );
    expect(html).toContain("Renews Sep 1, 2026");
    expect(html).toContain(">Active<");
    expect(html).not.toContain("Cancel subscription");
    expect(html).not.toContain("Keep subscription");
    expect(headings(render(loaderData()), 2)).not.toContain("Subscriptions");
  });

  it("shows the card on file, and Update payment method", () => {
    const html = text(render(loaderData()));
    expect(html).toContain("Visa ending 4242");
    expect(html).toContain("Expires 04/2030");
    expect(html).toContain("Update payment method");
  });

  it("with no card, says so truthfully: Foxhound emails no payment link", () => {
    const html = text(render(loaderData({ card: null })));
    expect(html).toContain("No payment method on file.");
    expect(html).toContain("Add payment method");
    expect(html).not.toContain("payment link");
    expect(html).not.toContain("A payment method is on file");
  });

  it("is built from Capsomer's parts and carries no amber and no Recova", () => {
    const html = render(loaderData());
    for (const part of ["cap-page-head", "cap-panel", "cap-rows", "cap-btn"]) expect(html).toContain(part);
    expect(html.toLowerCase()).not.toContain("amber");
    expect(html).not.toContain("Recova");
  });

  describe("states where Recova's next-invoice line would be false", () => {
    it("a billing-exempt account is told it is not invoiced", () => {
      const html = text(
        render(
          loaderData({
            preview: basePreview({
              estimatedRecoveryFees: [],
              estimatedDisputeFees: [],
              accountBillingState: { billingExempt: true, processingPaused: false, cancelledAt: null },
            }),
          }),
        ),
      );
      expect(html).toContain("Billing exempt. Foxhound does not invoice this account, so no fee is building up.");
      expect(html).not.toContain("Next invoice:");
      expect(html).not.toContain("Added to your next monthly invoice");
    });

    it("a paused account is told a pause defers a fee", () => {
      const html = text(
        render(
          loaderData({
            preview: basePreview({
              accountBillingState: { billingExempt: false, processingPaused: true, cancelledAt: null },
            }),
          }),
        ),
      );
      expect(html).toContain("Processing is paused. Nothing is invoiced while it stays paused.");
      expect(html).not.toContain("Next invoice:");
    });

    it("a cancelled account still sees its next invoice, and why", () => {
      const html = text(
        render(
          loaderData({
            preview: basePreview({
              accountBillingState: {
                billingExempt: false,
                processingPaused: false,
                cancelledAt: T("2026-07-09T00:00:00.000Z"),
              },
            }),
          }),
        ),
      );
      expect(html).toContain("This account is cancelled. Fees already earned still appear on the next invoice.");
      expect(html).toContain("Next invoice: August 1, 2026");
    });
  });
});
