import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";

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
const finalizeCalls = vi.hoisted(() => ({ n: 0 }));
vi.mock("~/lib/billing/platform-customer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/billing/platform-customer")>()),
  finalizeBillingSetupSession: async () => {
    finalizeCalls.n += 1;
  },
}));
const billingModule = await import("~/routes/app/billing/index");
const BillingRoute = billingModule.default;

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

function creditLine(id: string, fee: EnrichedLineItem, creditCents: number): EnrichedLineItem {
  return {
    ...fee,
    lineItem: {
      ...fee.lineItem,
      id,
      type: "credit",
      amountCents: -Math.abs(creditCents),
      feeCents: null,
      stripeCreditNoteId: `cn_${id}`,
      creditsLineItemId: fee.lineItem.id,
      createdAt: T("2026-08-05T00:00:00.000Z"),
    },
  } as EnrichedLineItem;
}

describe("review fixes (PR #68 review F1 to F5)", () => {

  it("F1: a dispute fee credited after billing shows its credit on the dispute row", () => {
    const fee = disputeLine("d9", "inv_c", 50_000, 10_000);
    const rows = buildDisputeFeeRows([invoice({ id: "inv_c" })], [fee, creditLine("cr2", fee, 10_000)], []);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ feeCents: 10_000, creditedCents: 10_000 });
  });

  it("F1: the rendered rows say Credited, with cents", () => {
    const rfee = recoveryLine("c1", "inv_c", 10_000, 2_000);
    const dfee = disputeLine("d9", "inv_c", 50_000, 10_000);
    const inv = [invoice({ id: "inv_c" })];
    const html = text(
      render(
        loaderData({
          recoveryHistory: buildRecoveryHistory(inv, [rfee, creditLine("cr1", rfee, 2_000)]),
          disputeFees: buildDisputeFeeRows(inv, [dfee, creditLine("cr2", dfee, 10_000)], []),
        }),
      ),
    );
    expect(html).toContain("Fee: $20.00 · Credited: $20.00");
    expect(html).toContain("Fee (20%): $100.00 · Credited: $100.00");
  });

  it("F4: an exempt account is not told it is invoiced on the 1st", () => {
    const html = text(
      render(
        loaderData({
          preview: basePreview({
            accountBillingState: { billingExempt: true, processingPaused: false, cancelledAt: null },
          }),
        }),
      ),
    );
    expect(html).toContain("20% of attributed recoveries");
    expect(html).not.toContain("Invoiced on the 1st");
  });
});

describe("ordinal (Recova's 'Invoiced on the 1st', from the run's day of month)", () => {
  it("says 1st, 2nd, 3rd, 4th, 11th, 12th, 13th, 21st", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21].map(ordinal)).toEqual([
      "1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st",
    ]);
  });
});

describe("the invoice day the page states is the billing run's own day", () => {
  it("BILLING_RUN_DAY_OF_MONTH and BILLING_RUN_HOUR_UTC are the fields of the monthly billing cron", async () => {
    const c = await import("~/lib/constants");
    expect(c.CRON_SCHEDULE_MONTHLY).toBe(`0 ${c.BILLING_RUN_HOUR_UTC} ${c.BILLING_RUN_DAY_OF_MONTH} * *`);
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
      periodLabel: "Invoiced July 1, 2026",
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
      invoice({
        id: `inv_${i}`,
        periodStart: T(new Date(Date.UTC(2025, i, 1)).toISOString()),
        createdAt: T(new Date(Date.UTC(2025, i + 1, 1, 4)).toISOString()),
      }),
    );
    const manyLines = many.map((inv, i) => recoveryLine(`m${i}`, inv.id, 1_000, 200));
    const rows = buildRecoveryHistory(many, manyLines);
    expect(rows).toHaveLength(12);
    expect(rows[0]!.periodLabel).toBe("Invoiced March 1, 2026");
    expect(rows[11]!.periodLabel).toBe("Invoiced April 1, 2025");
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
  it("an active subscription already canceled cancels on its period end", () => {
    expect(
      subscriptionDetail({ status: "active", canceledAt: T("2026-08-01T00:00:00.000Z"), currentPeriodEndsAt: end }),
    ).toEqual({ text: "Cancels on Sep 1, 2026", warn: true });
  });
  it("a canceled one with a period end expired", () => {
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


describe("/billing renders Recova's page on Foxhound's engine", () => {

  it("shows attributed recoveries this month and the next run's recovery fee, never the whole invoice", () => {
    const html = text(render(loaderData()));
    expect(html).toContain("Recovered this month");
    expect(html).toContain("$290");
    expect(html).toContain("Estimated fee (20%)");
    expect(html).toContain("$46.00");
    // The whole invoice (recovery plus dispute fees) is NOT the recovery fee.
    expect(html).not.toContain("$296");
    expect(html).toContain("Next invoice: August 1, 2026");
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

    it("a canceled account still sees its next invoice, and why", () => {
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
      expect(html).toContain("This account is canceled. Fees already earned still appear on the next invoice.");
      expect(html).toContain("Next invoice: August 1, 2026");
    });
  });
});

describe("the setup session's return leg", () => {
  it("never finalizes at Stripe in the demo or while an admin views as the merchant", async () => {
    for (const extra of [{ isDemo: true }, { isDemo: false, viewingAs: { adminEmail: "admin@foxhound.test" } }]) {
      const context = {
        get(key: unknown) {
          if (key === cloudflareContext) return { env: {}, ctx: {}, nonce: "n" };
          if (key === authContext) {
            return { userId: "u", membership: { accountId: "acct_1", role: "owner" }, isAdmin: false, ...extra };
          }
          throw new Error("unexpected context key");
        },
      };
      const thrown = await billingModule
        .loader({ context, request: new Request("https://foxhoundapp.test/billing?session_id=cs_x"), params: {} } as never)
        .catch((e: unknown) => e);
      expect(thrown).toBeInstanceOf(Response);
      expect((thrown as Response).headers.get("Location")).toBe("/billing");
    }
    expect(finalizeCalls.n).toBe(0);
  });
});
