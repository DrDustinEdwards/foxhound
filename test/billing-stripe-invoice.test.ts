import { beforeEach, describe, expect, it, vi } from "vitest";

// createPlatformInvoice calls the real Stripe SDK; mock the client factory so
// these tests assert the CALL SHAPE (order, params, idempotency keys) without
// a network call. This is a different testing style from the compile-test
// pattern used elsewhere (that pattern is for Drizzle batches; this function
// is not one), so it gets its own file rather than sharing the existing
// billing-platform.test.ts, which deliberately never mocks stripe/client.
const mockStripe = vi.hoisted(() => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  // Stripe's own idempotency behavior, modeled only as far as these tests
  // need it: a replayed key returns the ORIGINAL object instead of creating a
  // second one. `failOnKey` lets a test blow up one specific item to simulate
  // the mid-loop failure the per-item keys exist to make survivable.
  const items = { created: new Map<string, { id: string }>(), failOnKey: null as string | null };
  // The platform customer as customers.retrieve returns it. Defaults to a card
  // on file, which is the charge_automatically path every older test assumes.
  const customer = { value: { id: "cus_1", invoice_settings: { default_payment_method: "pm_1" }, default_source: null } as Record<string, unknown> };
  return {
    calls,
    invoiceItemState: items,
    customer,
    customers: {
      retrieve: vi.fn(async (id: string) => {
        calls.push({ method: "customers.retrieve", args: [id] });
        return customer.value;
      }),
      update: vi.fn(async (id: string, params: unknown) => {
        calls.push({ method: "customers.update", args: [id, params] });
        return { ...customer.value, ...(params as object) };
      }),
    },
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
      create: vi.fn(async (params: unknown, options: { idempotencyKey?: string } = {}) => {
        calls.push({ method: "invoiceItems.create", args: [params, options] });
        const key = options.idempotencyKey;
        if (key && key === items.failOnKey) throw new Error("stripe unavailable");
        if (key && items.created.has(key)) return items.created.get(key)!;
        const item = { id: `ii_${items.created.size + 1}` };
        if (key) items.created.set(key, item);
        return item;
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
  recoveryFeeItemIdempotencyKey,
  disputeFeeItemIdempotencyKey,
  lineItemIdempotencyKey,
} = await import("~/lib/billing/stripe-invoice");

beforeEach(() => {
  mockStripe.calls.length = 0;
  mockStripe.invoiceItemState.created.clear();
  mockStripe.invoiceItemState.failOnKey = null;
  mockStripe.customer.value = { id: "cus_1", invoice_settings: { default_payment_method: "pm_1" }, default_source: null };
  vi.clearAllMocks();
});

const RECOVERY_KEY = recoveryFeeItemIdempotencyKey("acc_1", "2026-06", "usd", "rec_1");
const DISPUTE_KEY = disputeFeeItemIdempotencyKey("dsp_1");

const baseInput = {
  platformCustomerId: "cus_1",
  currency: "usd",
  billingInvoiceId: "inv_1",
  periodStart: new Date(Date.UTC(2026, 5, 1)),
  lines: [
    {
      type: "recovery_fee",
      amountCents: 2_000,
      description: "Recovery fee",
      idempotencyKey: RECOVERY_KEY,
    },
    {
      type: "dispute_fee",
      amountCents: 10_000,
      description: "Dispute fee",
      idempotencyKey: DISPUTE_KEY,
    },
  ],
};

describe("createPlatformInvoice call shape (Phase 5 review HIGH fix)", () => {
  it("creates the invoice FIRST, as a draft, with pending items excluded, before any invoice item", async () => {
    await createPlatformInvoice({} as Env, baseInput);
    const methodOrder = mockStripe.calls.map((c) => c.method);
    expect(methodOrder).toEqual([
      "customers.retrieve",
      "invoices.create",
      "invoiceItems.create",
      "invoiceItems.create",
      "invoices.finalizeInvoice",
    ]);

    const create = mockStripe.calls.find((c) => c.method === "invoices.create")!;
    const [createParams, createOptions] = create.args as [Record<string, unknown>, Record<string, unknown>];
    expect(createParams.auto_advance).toBe(false);
    expect(createParams.pending_invoice_items_behavior).toBe("exclude");
    expect(createParams.customer).toBe("cus_1");
    expect(createParams.currency).toBe("usd");
    expect((createParams.metadata as Record<string, unknown>).billing_invoice_id).toBe("inv_1");
    expect(createOptions.idempotencyKey).toBe(platformInvoiceIdempotencyKey("inv_1"));
  });

  it("finalizes with a deterministic idempotency key derived from the same billing_invoices id", async () => {
    await createPlatformInvoice({} as Env, baseInput);
    const finalize = mockStripe.calls.find((c) => c.method === "invoices.finalizeInvoice");
    expect(finalize).toBeTruthy();
    const [id, , options] = finalize!.args as [string, unknown, Record<string, unknown>];
    expect(id).toBe("in_test_1");
    expect(options.idempotencyKey).toBe(platformInvoiceFinalizeIdempotencyKey("inv_1"));
  });

  it("carries a per-LINE idempotency key on every invoiceItems.create", () => {
    // Pre-fix, invoiceItems.create was called with ONE argument: no options
    // object at all, so no key. The create/finalize keys around it did nothing
    // to protect the items in between.
    return createPlatformInvoice({} as Env, baseInput).then(() => {
      const itemCalls = mockStripe.calls.filter((c) => c.method === "invoiceItems.create");
      const keys = itemCalls.map((c) => (c.args[1] as { idempotencyKey?: string })?.idempotencyKey);
      expect(keys).toEqual([RECOVERY_KEY, DISPUTE_KEY]);
    });
  });

  it("a mid-loop failure and a full retry leave EXACTLY one Stripe item per line", async () => {
    // The duplicate-charge path this commit closes. Three lines; the second
    // one blows up, so line 1 has already landed on the invoice when the whole
    // function is retried. Pre-fix the retry re-added line 1 (the create key
    // returned the same invoice, and the unkeyed item call created a second
    // copy), so the merchant's invoice carried line 1 twice.
    const threeLines = {
      ...baseInput,
      lines: [
        { type: "recovery_fee", amountCents: 2_000, description: "Recovery fee", idempotencyKey: "k_rec_1" },
        { type: "recovery_fee", amountCents: 3_000, description: "Recovery fee", idempotencyKey: "k_rec_2" },
        { type: "dispute_fee", amountCents: 10_000, description: "Dispute fee", idempotencyKey: "k_dsp_1" },
      ],
    };

    mockStripe.invoiceItemState.failOnKey = "k_rec_2";
    await expect(createPlatformInvoice({} as Env, threeLines)).rejects.toThrow("stripe unavailable");

    mockStripe.invoiceItemState.failOnKey = null;
    await createPlatformInvoice({} as Env, threeLines);

    // Five item CALLS were made (2 up to and including the failure, then all 3
    // on the retry), but Stripe deduped the replayed key, so only three real
    // items exist. Proven via the recorded call keys, per the TASK.
    const itemCalls = mockStripe.calls.filter((c) => c.method === "invoiceItems.create");
    const attemptedKeys = itemCalls.map(
      (c) => (c.args[1] as { idempotencyKey?: string })?.idempotencyKey,
    );
    expect(attemptedKeys).toEqual(["k_rec_1", "k_rec_2", "k_rec_1", "k_rec_2", "k_dsp_1"]);
    expect([...mockStripe.invoiceItemState.created.keys()]).toEqual(["k_rec_1", "k_rec_2", "k_dsp_1"]);

    // Every key is distinct, so no line was swallowed by another's key either.
    expect(new Set(attemptedKeys).size).toBe(3);
  });

  it("a retry for the SAME billing_invoices id derives the identical idempotency keys (Phase 8 retry groundwork)", () => {
    expect(platformInvoiceIdempotencyKey("inv_1")).toBe(platformInvoiceIdempotencyKey("inv_1"));
    expect(platformInvoiceIdempotencyKey("inv_1")).not.toBe(platformInvoiceIdempotencyKey("inv_2"));
    expect(platformInvoiceIdempotencyKey("inv_1")).not.toBe(platformInvoiceFinalizeIdempotencyKey("inv_1"));
  });

  it("gives every committed line its own key, so no line can replay another's item", () => {
    const ctx = { accountId: "acc_1", periodKey: "2026-06", currency: "usd" };
    const line = (id: string, type: string, recoveredPaymentId: string | null, disputeId: string | null) =>
      lineItemIdempotencyKey({ id, type, recoveredPaymentId, disputeId }, ctx);
    // Fee lines keep the keys the first charge already sent Stripe.
    expect(line("li_1", "recovery_fee", "rec_1", null)).toBe(RECOVERY_KEY);
    expect(line("li_2", "dispute_fee", null, "dsp_1")).toBe(DISPUTE_KEY);
    // Two lines with no evidence FK used to share one fallback key.
    expect(line("li_3", "subscription", null, null)).not.toBe(line("li_4", "subscription", null, null));
  });

  it("still drops adjustment lines and zero amounts before ever calling Stripe (chargeableLines unchanged)", async () => {
    await createPlatformInvoice(
      {} as Env,
      {
        ...baseInput,
        lines: [
          { type: "recovery_fee", amountCents: 2_000, description: "Recovery fee", idempotencyKey: "k_recovery_fee_2000" },
          { type: "adjustment", amountCents: -500, description: "Goodwill credit", idempotencyKey: "k_adjustment_neg500" },
          { type: "recovery_fee", amountCents: 0, description: "Zero", idempotencyKey: "k_recovery_fee_0" },
        ],
      },
    );
    const itemCalls = mockStripe.calls.filter((c) => c.method === "invoiceItems.create");
    expect(itemCalls).toHaveLength(1);
    expect((itemCalls[0].args[0] as Record<string, unknown>).amount).toBe(2_000);
  });
});

// E25 (J97): Recova emails the month's invoice when the platform customer has
// no payment method on file (collection_method send_invoice, days_until_due 30)
// and charges the card otherwise. Same rule for "on file" as Recova:
// invoice_settings.default_payment_method, else default_source.
describe("collection method follows the payment method on file (E25)", () => {
  const callOf = (method: string) => mockStripe.calls.find((c) => c.method === method)!;

  it("a customer with no default payment method gets send_invoice, 30 days, and a finalize that lets Stripe email it", async () => {
    mockStripe.customer.value = { id: "cus_1", email: "billing@example.com", invoice_settings: { default_payment_method: null }, default_source: null };
    await createPlatformInvoice({} as Env, baseInput);

    const [createParams, createOptions] = callOf("invoices.create").args as [Record<string, unknown>, Record<string, unknown>];
    expect(createParams.collection_method).toBe("send_invoice");
    expect(createParams.days_until_due).toBe(30);
    // Still a held draft while items attach, so a half-built invoice is never emailed.
    expect(createParams.auto_advance).toBe(false);
    expect(createOptions.idempotencyKey).toBe(platformInvoiceIdempotencyKey("inv_1"));

    const [, finalizeParams, finalizeOptions] = callOf("invoices.finalizeInvoice").args as [string, Record<string, unknown>, Record<string, unknown>];
    // Stripe emails a send_invoice invoice only when it advances automatically.
    expect(finalizeParams).toEqual({ auto_advance: true });
    expect(finalizeOptions.idempotencyKey).toBe(platformInvoiceFinalizeIdempotencyKey("inv_1"));

    const keys = mockStripe.calls
      .filter((c) => c.method === "invoiceItems.create")
      .map((c) => (c.args[1] as { idempotencyKey?: string }).idempotencyKey);
    expect(keys).toEqual([RECOVERY_KEY, DISPUTE_KEY]);
  });

  it("a customer with a card on file gets charge_automatically, finalized so Stripe charges the card", async () => {
    await createPlatformInvoice({} as Env, baseInput);

    const [createParams, createOptions] = callOf("invoices.create").args as [Record<string, unknown>, Record<string, unknown>];
    expect(createParams.collection_method).toBe("charge_automatically");
    expect(createParams).not.toHaveProperty("days_until_due");
    expect(createOptions.idempotencyKey).toBe(platformInvoiceIdempotencyKey("inv_1"));

    // Recova creates with auto_advance true, so Stripe charges the card on its
    // own within about an hour. With auto_advance left off Stripe never tries
    // the card and the fee waits a month for the retry sweep.
    const [, finalizeParams, finalizeOptions] = callOf("invoices.finalizeInvoice").args as [string, unknown, Record<string, unknown>];
    expect(finalizeParams).toEqual({ auto_advance: true });
    expect(finalizeOptions.idempotencyKey).toBe(platformInvoiceFinalizeIdempotencyKey("inv_1"));
  });

  it("describes the invoice as Recova does, with Foxhound's name and the billed month", async () => {
    await createPlatformInvoice({} as Env, baseInput);
    const [createParams] = callOf("invoices.create").args as [Record<string, unknown>];
    expect(createParams.description).toBe("Foxhound: June 2026");
  });

  it("a legacy default source counts as a payment method, as in Recova", async () => {
    mockStripe.customer.value = { id: "cus_1", invoice_settings: { default_payment_method: null }, default_source: "card_1" };
    await createPlatformInvoice({} as Env, baseInput);
    const [createParams] = callOf("invoices.create").args as [Record<string, unknown>];
    expect(createParams.collection_method).toBe("charge_automatically");
  });
});

// E25 (J97): a platform customer made before it carried an email has nowhere
// for Stripe to send the invoice, so the address is filled in first.
describe("an emailed invoice needs an address on the customer (E25)", () => {
  const noCard = { invoice_settings: { default_payment_method: null }, default_source: null };

  it("sets the resolved billing email on a customer with none, before the invoice is created", async () => {
    mockStripe.customer.value = { id: "cus_1", email: null, ...noCard };
    await createPlatformInvoice({} as Env, { ...baseInput, billingEmail: async () => "billing@example.com" });
    const methods = mockStripe.calls.map((c) => c.method);
    expect(methods.slice(0, 3)).toEqual(["customers.retrieve", "customers.update", "invoices.create"]);
    const update = mockStripe.calls.find((c) => c.method === "customers.update")!;
    expect(update.args).toEqual(["cus_1", { email: "billing@example.com" }]);
  });

  it("leaves a customer that already has an email alone", async () => {
    mockStripe.customer.value = { id: "cus_1", email: "kept@example.com", ...noCard };
    await createPlatformInvoice({} as Env, { ...baseInput, billingEmail: async () => "billing@example.com" });
    expect(mockStripe.calls.some((c) => c.method === "customers.update")).toBe(false);
  });
});

describe("an emailed invoice with no address to send to (E25 review)", () => {
  const noCard = { invoice_settings: { default_payment_method: null }, default_source: null };

  it("creates nothing at Stripe when no billing email can be found", async () => {
    mockStripe.customer.value = { id: "cus_1", email: null, ...noCard };
    await expect(
      createPlatformInvoice({} as Env, { ...baseInput, billingEmail: async () => null }),
    ).rejects.toThrow("no billing email");
    expect(mockStripe.calls.map((c) => c.method)).toEqual(["customers.retrieve"]);
  });

  it("keeps the address out of the error when Stripe refuses it", async () => {
    mockStripe.customer.value = { id: "cus_1", email: null, ...noCard };
    mockStripe.customers.update.mockImplementationOnce(async () => {
      throw Object.assign(new Error("Invalid email address: billing@example.com"), {
        type: "StripeInvalidRequestError",
        code: "email_invalid",
      });
    });
    const err = await createPlatformInvoice({} as Env, {
      ...baseInput,
      billingEmail: async () => "billing@example.com",
    }).catch((e: Error) => e);
    expect(String((err as Error).message)).not.toContain("billing@example.com");
    expect(String((err as Error).message)).toContain("email_invalid");
    expect(mockStripe.calls.some((c) => c.method === "invoices.create")).toBe(false);
  });
});
