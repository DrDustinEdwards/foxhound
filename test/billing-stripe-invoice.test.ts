import { beforeEach, describe, expect, it, vi } from "vitest";

// createPlatformInvoice calls the real Stripe SDK; mock the client factory so
// these tests assert the CALL SHAPE (order, params, idempotency keys) without
// a network call. This is a different testing style from the compile-test
// pattern used elsewhere (that pattern is for Drizzle batches; this function
// is not one), so it gets its own file rather than sharing the existing
// billing-platform.test.ts, which deliberately never mocks stripe/client.
const mockStripe = vi.hoisted(() => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  return {
    calls,
    invoices: {
      create: vi.fn(async (params: unknown, options: unknown) => {
        calls.push({ method: "invoices.create", args: [params, options] });
        return { id: "in_test_1", hosted_invoice_url: null };
      }),
      finalizeInvoice: vi.fn(async (id: string, params: unknown, options: unknown) => {
        calls.push({ method: "invoices.finalizeInvoice", args: [id, params, options] });
        return { id: "in_test_1", hosted_invoice_url: "https://pay.stripe.com/test" };
      }),
    },
    invoiceItems: {
      create: vi.fn(async (params: unknown) => {
        calls.push({ method: "invoiceItems.create", args: [params] });
        return { id: "ii_test" };
      }),
    },
  };
});

vi.mock("~/lib/stripe/client", () => ({
  getStripe: () => mockStripe,
}));

const {
  createPlatformInvoice,
  platformInvoiceIdempotencyKey,
  platformInvoiceFinalizeIdempotencyKey,
} = await import("~/lib/billing/stripe-invoice");

beforeEach(() => {
  mockStripe.calls.length = 0;
  vi.clearAllMocks();
});

const baseInput = {
  platformCustomerId: "cus_1",
  currency: "usd",
  billingInvoiceId: "inv_1",
  lines: [
    { type: "recovery_fee", amountCents: 2_000, description: "Recovery fee" },
    { type: "dispute_fee", amountCents: 10_000, description: "Dispute fee" },
  ],
};

describe("createPlatformInvoice call shape (Phase 5 review HIGH fix)", () => {
  it("creates the invoice FIRST, as a draft, with pending items excluded, before any invoice item", async () => {
    await createPlatformInvoice({} as Env, baseInput);
    const methodOrder = mockStripe.calls.map((c) => c.method);
    expect(methodOrder).toEqual([
      "invoices.create",
      "invoiceItems.create",
      "invoiceItems.create",
      "invoices.finalizeInvoice",
    ]);

    const create = mockStripe.calls[0];
    const [createParams, createOptions] = create.args as [Record<string, unknown>, Record<string, unknown>];
    expect(createParams.auto_advance).toBe(false);
    expect(createParams.pending_invoice_items_behavior).toBe("exclude");
    expect(createParams.customer).toBe("cus_1");
    expect(createParams.currency).toBe("usd");
    expect((createParams.metadata as Record<string, unknown>).billing_invoice_id).toBe("inv_1");
    expect(createOptions.idempotencyKey).toBe(platformInvoiceIdempotencyKey("inv_1"));
  });

  it("attaches every chargeable line explicitly to the created invoice id (never a bare pending item)", async () => {
    await createPlatformInvoice({} as Env, baseInput);
    const itemCalls = mockStripe.calls.filter((c) => c.method === "invoiceItems.create");
    expect(itemCalls).toHaveLength(2);
    for (const call of itemCalls) {
      const [params] = call.args as [Record<string, unknown>];
      expect(params.invoice).toBe("in_test_1");
      expect(params.customer).toBe("cus_1");
    }
    expect((itemCalls[0].args[0] as Record<string, unknown>).amount).toBe(2_000);
    expect((itemCalls[1].args[0] as Record<string, unknown>).amount).toBe(10_000);
  });

  it("finalizes with a deterministic idempotency key derived from the same billing_invoices id", async () => {
    await createPlatformInvoice({} as Env, baseInput);
    const finalize = mockStripe.calls.find((c) => c.method === "invoices.finalizeInvoice");
    expect(finalize).toBeTruthy();
    const [id, , options] = finalize!.args as [string, unknown, Record<string, unknown>];
    expect(id).toBe("in_test_1");
    expect(options.idempotencyKey).toBe(platformInvoiceFinalizeIdempotencyKey("inv_1"));
  });

  it("a retry for the SAME billing_invoices id derives the identical idempotency keys (Phase 8 retry groundwork)", () => {
    expect(platformInvoiceIdempotencyKey("inv_1")).toBe(platformInvoiceIdempotencyKey("inv_1"));
    expect(platformInvoiceIdempotencyKey("inv_1")).not.toBe(platformInvoiceIdempotencyKey("inv_2"));
    expect(platformInvoiceIdempotencyKey("inv_1")).not.toBe(platformInvoiceFinalizeIdempotencyKey("inv_1"));
  });

  it("still drops adjustment lines and zero amounts before ever calling Stripe (chargeableLines unchanged)", async () => {
    await createPlatformInvoice(
      {} as Env,
      {
        ...baseInput,
        lines: [
          { type: "recovery_fee", amountCents: 2_000, description: "Recovery fee" },
          { type: "adjustment", amountCents: -500, description: "Goodwill credit" },
          { type: "recovery_fee", amountCents: 0, description: "Zero" },
        ],
      },
    );
    const itemCalls = mockStripe.calls.filter((c) => c.method === "invoiceItems.create");
    expect(itemCalls).toHaveLength(1);
    expect((itemCalls[0].args[0] as Record<string, unknown>).amount).toBe(2_000);
  });
});
