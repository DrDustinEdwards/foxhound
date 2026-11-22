import { describe, expect, it, vi } from "vitest";

import {
  accounts,
  adminAuditLog,
  apiKeys,
  billingInvoices,
  billingLineItems,
  customerContext,
  disputeApprovals,
  disputeEvidence,
  disputes,
  expiringCardAlerts,
  failedPayments,
  intelligenceReports,
  recoverySteps,
  stripeConnections,
  winBackSequences,
} from "~/db/schema";
import { MCP_TOKEN_PREFIX, MCP_TOKEN_SCOPE } from "~/lib/auth/mcp-tokens";
import { maskEmail, redactToolResult } from "~/lib/mcp/redact";

import { createInMemoryDb } from "./helpers/inmemory-db";
import {
  mcpRequest,
  readMcp,
  toolOutput,
  toolCallLogStub,
  confirmedCall,
  TEST_LINK_KEY,
} from "./helpers/mcp-client";

// What the read tools return. The redaction is structural: no tool returns a customer name or a
// raw email, asserted over the response bytes rather than field by field (a field list is a guess
// about which field the next helper adds). Fixtures are built so an absence check discriminates:
// every customer is at risk (score 12, under the 40 the aggregate views filter on) and every
// failed payment, dispute and recovery step carries the customer's name, so a leak returns
// something rather than an empty list an absence assertion would wave through. Also here: the
// settings reader never returns the Slack webhook URL, and pagination cursors belong to their tool.

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const { handleMcpRequest } = await import("~/lib/mcp/handler.server");
const { sha256Hex } = await import("@dustinedwards/site-runtime/encoding");
const { MERCHANT_TOOLS } = await import("~/lib/mcp/tools.server");

const MINE = "acct_mine";
const THEIRS = "acct_theirs";
const NOW = new Date("2026-08-25T12:00:00.000Z");

/** Values that must never appear in a response. Deliberately distinctive, so a
 *  substring search over the bytes cannot match by accident. */
const MY_NAME = "Zebulon Quicksilver";
const MY_EMAIL = "zebulon.quicksilver@example.test";
const THEIR_NAME = "Persephone Nightingale";
const THEIR_EMAIL = "persephone.nightingale@other.test";
const MY_WEBHOOK = "https://hooks.slack.com/services/T0MINE/B0MINE/zanzibarQuokkaSecret";

function env(): Env {
  return {
    DB: {},
    TOOL_CALL_LOG: toolCallLogStub(),
    EMAIL_TOKEN_KEY: TEST_LINK_KEY,
    RATE_LIMITER: {
      idFromName: (n: string) => n,
      get: () => ({ hit: async () => ({ ok: true, retryAfterSeconds: 60 }) }),
    },
  } as unknown as Env;
}

/** Two accounts, each with a customer, a failed payment, a dispute, a recovery step and a
 *  connection. `extraPayments` adds that many more failed payments to MINE only. */
async function seed(extraPayments = 0) {
  const { db } = createInMemoryDb();
  harness.db = db;
  const tokens: Record<string, string> = {};
  for (const [account, name, email] of [
    [MINE, MY_NAME, MY_EMAIL],
    [THEIRS, THEIR_NAME, THEIR_EMAIL],
  ] as const) {
    await db.insert(accounts).values({
      id: account,
      name: account,
      createdAt: NOW,
      currency: "usd",
      merchantIndustry: `industry of ${account}`,
      primaryCustomerType: `customers of ${account}`,
      slackWebhookUrl: account === MINE ? MY_WEBHOOK : null,
    });
    const token = `${MCP_TOKEN_PREFIX}${account}`;
    tokens[account] = token;
    await db.insert(apiKeys).values({
      id: `key_${account}`,
      accountId: account,
      keyHash: await sha256Hex(token),
      label: "agent",
      scope: MCP_TOKEN_SCOPE.MERCHANT,
      scopes: ["merchant.read", "merchant.write"],
      createdAt: NOW,
    });
    await db.insert(stripeConnections).values({
      id: `sc_${account}`,
      accountId: account,
      stripeUserId: `acct_stripe_${account}`,
      stripeAccessToken: "enc",
      isPrimary: true,
      connectedAt: NOW,
      createdAt: NOW,
      brandVoice: "warm",
      brandVoiceSamples: JSON.stringify([`Hi ${name}, thanks for staying with us.`]),
    });
    await db.insert(customerContext).values({
      id: `cc_${account}`,
      accountId: account,
      stripeCustomerId: `cus_${account}`,
      customerName: name,
      customerEmail: email,
      currency: "usd",
      mrrContributionCents: 5000,
      healthScore: 12,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await db.insert(failedPayments).values({
      id: `fp_${account}`,
      stripeEventId: `evt_${account}`,
      stripeInvoiceId: `in_${account}`,
      stripeCustomerId: `cus_${account}`,
      customerEmail: email,
      // The name too, because foxhound_get_payment returns the failed-payment
      // ROW (`db.select()`), and a fixture with a null name here would let that
      // tool pass the sweep with nothing to hide.
      customerName: name,
      amountCents: 9900,
      currency: "usd",
      declineCategory: "soft",
      status: "active",
      detectedAt: NOW,
      accountId: account,
    });
    await db.insert(disputes).values({
      id: `dp_${account}`,
      accountId: account,
      stripeDisputeId: `dp_stripe_${account}`,
      stripeChargeId: `ch_${account}`,
      stripeCustomerId: `cus_${account}`,
      customerEmail: email,
      customerName: name,
      amountCents: 4200,
      currency: "usd",
      reason: "fraudulent",
      status: "needs_response",
      state: "draft",
      createdAt: NOW,
      // The columns the boundary redactor cannot reach, which is why the tool
      // projects instead of returning the row. Each is asserted absent below.
      customerIp: "203.0.113.77",
      billingAddress: "14 Coriander Lane, Bakersfield",
      aiResponseText: `Dear ${name}, we are contesting this dispute.`,
      triageReasoning: `${name} has three prior charges on file.`,
    });
    // A sent recovery email, whose text greets the customer by name and whose
    // send error names their address. foxhound_get_payment returns the steps,
    // and the redactor deliberately leaves Foxhound's own text alone, so
    // only the tool's step projection keeps these off the wire.
    await db.insert(recoverySteps).values({
      id: `rs_${account}`,
      failedPaymentId: `fp_${account}`,
      accountId: account,
      stepType: "email",
      stepNumber: 1,
      scheduledAt: NOW,
      executedAt: NOW,
      aiSubject: `${name}, your payment did not go through`,
      aiBodyHtml: `<p>Hi ${name},</p>`,
      customBody: `Dear ${name}`,
      lastAttemptError: `bounced: ${email}`,
    });
  }
  for (let i = 0; i < extraPayments; i++) {
    await db.insert(failedPayments).values({
      id: `fp_${MINE}_extra_${i}`,
      stripeEventId: `evt_${MINE}_extra_${i}`,
      stripeInvoiceId: `in_${MINE}_extra_${i}`,
      stripeCustomerId: `cus_${MINE}`,
      customerEmail: MY_EMAIL,
      amountCents: 1000 + i,
      currency: "usd",
      declineCategory: "soft",
      status: "active",
      // Distinct times, so "newest first" is a total order and pages cannot overlap on a tie.
      detectedAt: new Date(NOW.getTime() - (i + 1) * 60_000),
      accountId: MINE,
    });
  }
  return { db, tokens };
}

/** One tools/call through the REAL handler and the SDK, read back as the bytes the agent would
 *  receive (the JSON-RPC message), through the confirmation step a write needs. */
async function callTool(token: string, name: string, args: Record<string, unknown> = {}) {
  const res = await confirmedCall(
    (a) =>
      handleMcpRequest(
        mcpRequest({ token, method: "tools/call", params: { name, arguments: a } }),
        env(),
        MERCHANT_TOOLS,
      ),
    args,
  );
  const answer = await readMcp(res);
  return { status: answer.status, text: answer.text, ...toolOutput(answer) };
}

describe("customer names and addresses never leave", () => {
  it("foxhound_get_payment keeps the name nulled and the email masked, and returns each step's facts but never the email Foxhound wrote", async () => {
    const { tokens } = await seed();
    const { text, isError, data } = await callTool(tokens[MINE], "foxhound_get_payment", {
      payment_id: `fp_${MINE}`,
    });
    expect(isError, text).toBe(false);
    // The detail is the failed-payment ROW, the one place a name rides on a payment rather than
    // a customer, so the field is proved present-and-redacted rather than merely absent.
    const failedPayment = data.failedPayment as Record<string, unknown>;
    expect(failedPayment.id).toBe(`fp_${MINE}`);
    expect(failedPayment.customerName).toBeNull();
    expect(failedPayment.customerEmail).toBe("z***@example.test");
    expect(failedPayment.amountCents).toBe(9900);
    // The step is there, so the absence below is the projection and not an empty list.
    const steps = data.steps as Record<string, unknown>[];
    expect(steps.map((step) => step.id)).toEqual([`rs_${MINE}`]);
    for (const field of ["aiSubject", "aiBodyHtml", "customBody", "lastAttemptError"]) {
      expect(text, field).not.toContain(field);
    }
    expect(text).not.toContain(MY_NAME);
    expect(text).not.toContain(MY_EMAIL);
  });

  it("the walk: masks fail closed, keeps Dates as Dates, and a cycle terminates redacted", () => {
    expect(maskEmail("alice@example.com")).toBe("a***@example.com");
    expect(maskEmail(null)).toBeNull();
    expect(maskEmail("")).toBeNull();
    // No @, a trailing @ or a leading @ cannot be masked by the rule, and passing one through
    // unchanged would be the one path a raw value escapes.
    for (const malformed of ["not-an-email", "trailing@", "@leading.test"]) {
      expect(maskEmail(malformed)).toBe("***");
    }

    const at = new Date("2026-01-02T03:04:05.000Z");
    const dated = redactToolResult({ createdAt: at, customerName: MY_NAME }) as { createdAt: Date };
    expect(dated.createdAt).toBeInstanceOf(Date);
    expect(dated.createdAt.toISOString()).toBe(at.toISOString());

    // An email field holding a non-string is a shape nobody predicted; only the fully masked
    // answer cannot leak.
    const odd = redactToolResult({
      a: { customerEmail: 12345 },
      b: { customerEmail: { raw: MY_EMAIL } },
      c: { customerEmail: [MY_EMAIL] },
      d: { customerEmail: null },
    }) as Record<string, { customerEmail: unknown }>;
    expect([odd.a, odd.b, odd.c].map((o) => o.customerEmail)).toEqual(["***", "***", "***"]);
    expect(JSON.stringify(odd)).not.toContain(MY_EMAIL);
    expect(odd.d.customerEmail).toBeNull();

    // A cycle must not be the one path where the rule fails open.
    const node: Record<string, unknown> = { customerName: MY_NAME };
    node.self = node;
    const out = redactToolResult(node) as Record<string, unknown>;
    expect(out.customerName).toBeNull();
    expect(out.self).toBe(out);
  });
});

describe("the settings reader", () => {
  it("never returns the Slack webhook URL, only that one is configured", async () => {
    const { tokens } = await seed();
    const { isError, data, text } = await callTool(tokens[MINE], "foxhound_get_settings");
    expect(isError, text).toBe(false);
    // Configured is true, which is what makes the absence check discriminate: the reader saw the
    // column, so the URL being absent is the projection working.
    expect((data.notifications as Record<string, unknown>).slackWebhookConfigured).toBe(true);
    for (const leaked of [
      MY_WEBHOOK,
      "zanzibarQuokkaSecret",
      "hooks.slack.com",
      "slackWebhookUrl",
    ]) {
      expect(text, leaked).not.toContain(leaked);
    }
  });

  it("intelligence_context round-trips: changing the industry leaves the other fields alone", async () => {
    const { tokens } = await seed();
    const read = async () =>
      (await callTool(tokens[MINE], "foxhound_get_settings")).data.intelligence_context;
    const before = (await read()) as Record<string, unknown>;
    const write = await callTool(tokens[MINE], "foxhound_update_settings", {
      intelligence_context: { merchant_industry: "observatory supplies" },
    });
    expect(write.isError, write.text).toBe(false);
    const after = await read();
    expect(after).toEqual({ ...before, merchantIndustry: "observatory supplies" });
    // The writer's state and the next read are the same object, key for key.
    expect((write.data as { state: unknown }).state).toEqual(after);
  });
});

describe("pagination is one shape, and a cursor belongs to its tool", () => {
  it("foxhound_list_payments walks every page with page_size 10, and the last says so", async () => {
    // 1 seeded + 22 extra = 23 payments on MINE: pages of 10, 10 and 3. THEIRS holds one more,
    // which must appear on no page.
    const { tokens } = await seed(22);
    const seen: string[] = [];
    let cursor: string | null = null;
    const pages: { count: number; has_more: unknown; next_cursor: unknown }[] = [];
    for (let guard = 0; guard < 5; guard++) {
      const args: Record<string, unknown> = { page_size: 10 };
      if (cursor) args.cursor = cursor;
      const answer = await callTool(tokens[MINE], "foxhound_list_payments", args);
      expect(answer.isError, answer.text).toBe(false);
      expect(answer.text).not.toContain(THEIRS);
      const payments = answer.data.payments as { id: string }[];
      expect(answer.data.total).toBe(23);
      pages.push({
        count: payments.length,
        has_more: answer.data.has_more,
        next_cursor: answer.data.next_cursor,
      });
      seen.push(...payments.map((p) => p.id));
      if (answer.data.has_more !== true) break;
      expect(typeof answer.data.next_cursor).toBe("string");
      cursor = answer.data.next_cursor as string;
    }
    expect(pages.map((p) => p.count)).toEqual([10, 10, 3]);
    expect(pages.map((p) => p.has_more)).toEqual([true, true, false]);
    expect(pages[2].next_cursor).toBeNull();
    // Every page is new rows: the cursor really read on rather than returning page one again.
    expect(new Set(seen).size).toBe(23);
  });

  it("a cursor from one tool is refused by another, and a junk cursor is refused", async () => {
    // Stacked guard: the disputes list on this fixture has no page 2, so a cursor read as a page
    // number would come back as an empty, valid answer. Only the tool check can make it an error.
    const { tokens } = await seed(22);
    const first = await callTool(tokens[MINE], "foxhound_list_payments", { page_size: 10 });
    const foreign = first.data.next_cursor as string;
    expect(typeof foreign).toBe("string");
    for (const name of [
      "foxhound_list_disputes",
      "foxhound_list_customers",
      "foxhound_review_audits",
    ]) {
      const answer = await callTool(tokens[MINE], name, { cursor: foreign });
      expect(answer.status, name).toBe(200);
      expect(answer.isError, `${name} accepted another tool's cursor`).toBe(true);
      expect(String(answer.data.error), name).toContain(name);
    }
    // The disputes list's own first page answers cleanly, so the refusal is the cursor.
    const own = await callTool(tokens[MINE], "foxhound_list_disputes");
    expect(own.isError).toBe(false);
    expect(own.data.has_more).toBe(false);
    const junk = await callTool(tokens[MINE], "foxhound_list_payments", { cursor: "not-a-cursor" });
    expect(junk.isError).toBe(true);
  });
});

describe("text the field walk cannot see into", () => {
  it("foxhound_get_overview names the customer in the narrative by Stripe id, never by name", async () => {
    const { db, tokens } = await seed();
    await db.insert(intelligenceReports).values({
      id: "ir_mine",
      accountId: MINE,
      reportMonth: NOW,
      narrative: `The lowest health score is ${MY_NAME} at 12/100. Reach out to ${MY_NAME} this week.`,
      generatedAt: NOW,
    });
    const { isError, data, text } = await callTool(tokens[MINE], "foxhound_get_overview");
    expect(isError, text).toBe(false);
    expect((data.overview as { narrative: string }).narrative).toBe(
      `The lowest health score is cus_${MINE} at 12/100. Reach out to cus_${MINE} this week.`,
    );
    expect(text).not.toContain("Zebulon");
  });

  it("foxhound_get_settings returns the brand voice without the pasted sample emails", async () => {
    const { tokens } = await seed();
    const { isError, data, text } = await callTool(tokens[MINE], "foxhound_get_settings");
    expect(isError, text).toBe(false);
    const voice = data.brand_voice as Record<string, unknown>;
    expect(voice.general).toBe("warm");
    expect("samples" in voice).toBe(false);
    expect(text).not.toContain("Zebulon");
  });
});

describe("dispute, invoice, win-back and report reads keep names, addresses and text out", () => {
  it("one dispute in full returns evidence sizes and the approval trail, never the evidence text, the IP or the approver's address", async () => {
    const { db, tokens } = await seed();
    await db.insert(disputeEvidence).values({
      id: "de_mine",
      disputeId: `dp_${MINE}`,
      accountId: MINE,
      fieldName: "customer_communication",
      fieldValue: `${MY_NAME} wrote to us on 3 May.`,
      createdAt: NOW,
    });
    await db.insert(disputeApprovals).values({
      id: "da_mine",
      disputeId: `dp_${MINE}`,
      accountId: MINE,
      approvedByUserId: "user_mine",
      approvedByEmail: "owner.person@example.test",
      evidenceVersionHash: "hash",
      approvedAt: NOW,
      standingOptInAt: NOW,
    });
    const { isError, data, text } = await callTool(tokens[MINE], "foxhound_list_disputes", {
      dispute_id: `dp_${MINE}`,
    });
    expect(isError, text).toBe(false);
    const dispute = data.dispute as Record<string, unknown>;
    expect(dispute.evidence).toEqual([
      {
        field: "customer_communication",
        characters: `${MY_NAME} wrote to us on 3 May.`.length,
        staged_at: NOW.toISOString(),
      },
    ]);
    // Automatic, because the approval stands on an opt-in, and the approver is masked.
    expect((dispute.approval as Record<string, unknown>).automatic).toBe(true);
    expect((dispute.approval as Record<string, unknown>).approved_by).toBe("o***@example.test");
    for (const leaked of [MY_NAME, MY_EMAIL, "203.0.113.77", "Coriander", "owner.person"]) {
      expect(text, leaked).not.toContain(leaked);
    }
  });

  it("an invoice in full returns its lines without the dispute row or the admin's address", async () => {
    const { db, tokens } = await seed();
    await db.insert(billingInvoices).values({
      id: "inv_mine",
      accountId: MINE,
      currency: "usd",
      periodStart: new Date("2026-07-01T00:00:00.000Z"),
      periodEnd: new Date("2026-08-01T00:00:00.000Z"),
      status: "paid",
      totalCents: 840,
      idempotencyKey: "idem_mine",
      createdAt: NOW,
    });
    await db.insert(adminAuditLog).values({
      id: "aal_mine",
      actorEmail: "dustin.admin@example.test",
      action: "create_adjustment",
      createdAt: NOW,
    });
    await db.insert(billingLineItems).values([
      {
        id: "li_dispute",
        invoiceId: "inv_mine",
        accountId: MINE,
        type: "dispute_fee",
        currency: "usd",
        amountCents: 4200,
        feeCents: 840,
        disputeId: `dp_${MINE}`,
        createdAt: NOW,
      },
      {
        id: "li_adjust",
        invoiceId: "inv_mine",
        accountId: MINE,
        type: "adjustment",
        currency: "usd",
        amountCents: -100,
        adminAuditLogId: "aal_mine",
        createdAt: new Date(NOW.getTime() + 1),
      },
    ]);
    const { isError, data, text } = await callTool(tokens[MINE], "foxhound_get_billing", {
      invoice_id: "inv_mine",
    });
    expect(isError, text).toBe(false);
    const lines = data.line_items as Record<string, unknown>[];
    expect(lines.map((l) => l.id)).toEqual(["li_dispute", "li_adjust"]);
    expect((lines[0].dispute as Record<string, unknown>).stripeDisputeId).toBe(`dp_stripe_${MINE}`);
    expect(lines[1].adjustmentRecordedAt).toBe(NOW.toISOString());
    for (const leaked of [MY_NAME, MY_EMAIL, "203.0.113.77", "Coriander", "dustin.admin"]) {
      expect(text, leaked).not.toContain(leaked);
    }
    // The summary's ledger is picked the same way: no whole dispute row, no admin address.
    const summary = await callTool(tokens[MINE], "foxhound_get_billing", {});
    expect(summary.isError, summary.text).toBe(false);
    for (const leaked of [MY_NAME, MY_EMAIL, "203.0.113.77", "Coriander", "dustin.admin"]) {
      expect(summary.text, leaked).not.toContain(leaked);
    }
    expect(summary.text).not.toContain("triageReasoning");
    expect(summary.text).not.toContain("adminAuditEntry");
  });

  it("win-back and expiring cards come back masked, with no cancel reason", async () => {
    const { db, tokens } = await seed();
    await db.insert(winBackSequences).values({
      id: "wb_mine",
      stripeCustomerId: `cus_${MINE}`,
      stripeSubscriptionId: "sub_mine",
      customerEmail: MY_EMAIL,
      customerName: MY_NAME,
      planName: "Pro",
      amountCents: 2900,
      currency: "usd",
      cancelReason: `${MY_NAME} said the price was too high`,
      status: "active",
      createdAt: NOW,
      accountId: MINE,
    });
    await db.insert(expiringCardAlerts).values({
      id: "ec_mine",
      stripeCustomerId: `cus_${MINE}`,
      customerEmail: MY_EMAIL,
      customerName: MY_NAME,
      cardLast4: "4242",
      cardBrand: "visa",
      expiresMonth: 7,
      expiresYear: 2026,
      createdAt: NOW,
      accountId: MINE,
    });
    const winback = await callTool(tokens[MINE], "foxhound_get_recovery", { view: "winback" });
    expect(winback.isError, winback.text).toBe(false);
    expect((winback.data.sequences as unknown[]).length).toBe(1);
    const cards = await callTool(tokens[MINE], "foxhound_get_recovery", {
      view: "expiring_cards",
    });
    expect(cards.isError, cards.text).toBe(false);
    // Expired in July 2026 and now is August 2026.
    expect((cards.data.cards as Record<string, unknown>[])[0].expired).toBe(true);
    for (const bytes of [winback.text, cards.text]) {
      for (const leaked of [MY_NAME, MY_EMAIL, "too high"])
        expect(bytes, leaked).not.toContain(leaked);
    }
  });

  it("recommendations drop the name, and the report archive swaps names for ids", async () => {
    const { db, tokens } = await seed();
    await db.insert(intelligenceReports).values({
      id: "ir_old",
      accountId: MINE,
      reportMonth: NOW,
      narrative: `${MY_NAME} is at risk.`,
      generatedAt: NOW,
    });
    const reports = await callTool(tokens[MINE], "foxhound_get_intelligence", { view: "reports" });
    expect(reports.isError, reports.text).toBe(false);
    expect((reports.data.reports as Record<string, unknown>[])[0].narrative).toBe(
      `cus_${MINE} is at risk.`,
    );
    expect(reports.text).not.toContain("Zebulon");
    const recs = await callTool(tokens[MINE], "foxhound_get_intelligence", {
      view: "recommendations",
    });
    expect(recs.isError, recs.text).toBe(false);
    expect(recs.text).not.toContain("Zebulon");
    expect(recs.text).not.toContain(THEIR_NAME);
  });
});
