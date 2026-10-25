import { beforeEach, describe, expect, it, vi } from "vitest";

// The merchant's own past emails and the family's stock-phrasing check, an
// approved difference from Recova (parity/APPROVED-DIFFERENCES.md, 2026-10-24).
// The check itself is site-runtime ./prose's and is tested there; these hold
// Foxhound's part: the samples are saved, read and reach both prompts as data;
// a draft that copies a sample's link, address or sentences sends the
// template; a draft with stock phrasing is retried once, and what the retry
// leaves is sent, since one stock word costs less than the template. The
// other model-written texts (dispute evidence, the Intelligence narrative, the
// audit summary) share the retry in ai/plain-writing.ts; one plant here proves
// the wiring outside the email path.
//
// The model is stubbed at the client factory, as timing-word-guard does.

const harness = vi.hoisted(() => ({
  calls: [] as { system?: unknown; messages: { role: string; content: string }[] }[],
  replies: [] as Record<string, string>[],
}));

vi.mock("~/lib/ai/client", () => ({
  createAnthropicClient: () => ({
    messages: {
      create: async (params: { system?: unknown; messages: { role: string; content: string }[] }) => {
        harness.calls.push(params);
        const next = harness.replies.shift();
        if (!next) throw new Error("no stub reply queued");
        return { content: [{ type: "text", text: JSON.stringify(next) }] };
      },
    },
  }),
}));

const { createInMemoryDb } = await import("./helpers/inmemory-db");
const { accounts, stripeConnections } = await import("~/db");
const { applyBrandVoice } = await import("~/lib/settings/apply.server");
const { getPrimaryBrandVoices } = await import("~/lib/settings/queries.server");
const { readVoiceSamples } = await import("~/lib/recovery/voice-samples");
const { buildGenerateEmailInput } = await import("~/lib/engine/execute-step");
const { queryStepForManualTrigger, toEmailContext } = await import("~/lib/cron/due-steps");
const { buildPrompts, findBrandVoiceViolations, generateDunningEmail, passesQualityGate } = await import(
  "~/lib/recovery/email-generation"
);
const { buildWinbackPrompt, generateWinbackEmail } = await import("~/lib/recovery/winback-generation");
const { draftDisputeEvidence } = await import("~/lib/disputes/evidence");

const env = { ANTHROPIC_API_KEY: "sk-ant-test" } as unknown as Env;
const UPDATE_URL = "https://foxhoundapp.test/u/tok-123";
const CLEAN = {
  subject: "Your Acme card didn't go through",
  bodyHtml: `<p>Hi Sam, your card didn't go through. <a href="${UPDATE_URL}">You can update it here</a>.</p><p>Thanks, Jo</p>`,
};
const STOCK = {
  subject: "A quick note about your Acme plan",
  bodyHtml: `<p>No hard feelings if you would rather stop. We genuinely value you.</p><p><a href="${UPDATE_URL}">Update your card</a>.</p>`,
};
const SAMPLE = "Hey folks, Jo here. Short one: the roaster's back <on> Friday. Cheers, Jo";

beforeEach(() => {
  harness.calls = [];
  harness.replies = [];
});

describe("sample emails", () => {
  it("saves the pasted emails, leaves them alone when a caller omits them, and clears them when emptied", async () => {
    const { db } = createInMemoryDb();
    const createdAt = new Date("2026-10-01T00:00:00Z");
    await db.insert(accounts).values({ id: "acct_a", name: "Sample A", createdAt });
    await db
      .insert(stripeConnections)
      .values({ id: "sc_a", accountId: "acct_a", stripeUserId: "acct_1Sample", isPrimary: true, createdAt });

    const saved = await applyBrandVoice(db, "acct_a", { connectionId: "sc_a", samples: [` ${SAMPLE} `, "", "Second one."] });
    expect(saved.ok && saved.state.samples).toEqual([SAMPLE, "Second one."]);

    // The MCP tool names no samples: the four voices change, the samples stay.
    await applyBrandVoice(db, "acct_a", { connectionId: "sc_a", soft: "calm" });
    expect(readVoiceSamples((await getPrimaryBrandVoices(db, "acct_a"))?.samples)).toEqual([SAMPLE, "Second one."]);

    await applyBrandVoice(db, "acct_a", { connectionId: "sc_a", samples: ["", "", "", "", ""] });
    expect((await getPrimaryBrandVoices(db, "acct_a"))?.samples).toBeNull();
  });

  it("reach a payment on any of the account's connections, read from the primary one they are saved on", async () => {
    const { db, sqlite } = createInMemoryDb();
    sqlite.prepare("INSERT INTO accounts (id, name, created_at, live_sends_enabled) VALUES ('acct_a', 'Sample A', 1000, 1)").run();
    const connect = sqlite.prepare(
      "INSERT INTO stripe_connections (id, account_id, stripe_user_id, is_primary, stripe_access_token, sender_name, brand_voice_samples, connected_at, created_at) VALUES (?, 'acct_a', ?, ?, 'cipher', 'Acme', ?, 1000, 1000)",
    );
    connect.run("sc_primary", "acct_1Primary", 1, JSON.stringify([SAMPLE]));
    connect.run("sc_second", "acct_1Second", 0, null);
    sqlite.prepare(
      "INSERT INTO failed_payments (id, account_id, stripe_event_id, stripe_invoice_id, stripe_customer_id, customer_email, customer_name, amount_cents, currency, decline_category, status, detected_at, stripe_connection_id) VALUES ('fp_1', 'acct_a', 'evt', 'in_1', 'cus_1', 'buyer@example.com', 'Sam', 4900, 'usd', 'soft', 'active', 1000, 'sc_second')",
    ).run();
    sqlite.prepare(
      "INSERT INTO recovery_steps (id, account_id, failed_payment_id, step_type, step_number, scheduled_at, attempt_count) VALUES ('step_1', 'acct_a', 'fp_1', 'email_day1', 1, 1000, 0)",
    ).run();

    const row = await queryStepForManualTrigger(db as never, "acct_a", "step_1");
    expect(toEmailContext(row!).voiceSamples).toEqual([SAMPLE]);
  });

  it("reaches the recovery and win-back prompts as data, through the production assembly", () => {
    const input = buildGenerateEmailInput(UPDATE_URL, {
      stepType: "soft_1",
      declineCategory: "soft",
      amountCents: 4900,
      currency: "usd",
      merchantName: "Acme",
      voiceSamples: [SAMPLE],
    } as unknown as Parameters<typeof buildGenerateEmailInput>[1]);
    const escaped = "<data>Hey folks, Jo here. Short one: the roaster's back &lt;on&gt; Friday. Cheers, Jo</data>";
    expect(buildPrompts(input).system).toContain(`Sample 1: ${escaped}`);
    expect(
      buildWinbackPrompt({
        stepNumber: 1,
        offsetHours: 1,
        customerName: "Sam",
        planName: "Pro",
        cancelReason: null,
        brandVoice: null,
        voiceSamples: [SAMPLE],
        senderName: "Acme",
        resubscribeUrl: "https://foxhoundapp.test/p/tok-456",
      }),
    ).toContain(`Sample 1: ${escaped}`);
  });
});

describe("what a draft was never given", () => {
  const samples = [`Hi all, the spring sale ends Friday so grab twenty percent off now. Pay at https://pay.example.com/x. Jo`];
  const withSamples = { merchant: { merchantName: "Acme", voiceSamples: samples }, stepType: "soft_1", declineCategory: "soft", amountFormatted: "$49.00", updateUrl: UPDATE_URL };

  it("PLANT: a sample's link, an email address or a copied sentence sends the template", async () => {
    for (const body of [
      `<p>Your card failed. <a href="https://pay.example.com/x">Pay here</a>.</p>`,
      `<p>Your card failed. <a href="${UPDATE_URL}">Update it</a>, or pay at https://pay.example.com/x.</p>`,
      `<p>Your card failed. <a href="${UPDATE_URL}">Update it</a> or write to jo@example.com.</p>`,
      `<p>The spring sale ends Friday so grab twenty percent off now. <a href="${UPDATE_URL}">Update it</a>.</p>`,
    ]) {
      harness.replies.push({ subject: CLEAN.subject, bodyHtml: body });
      await expect(generateDunningEmail(env, withSamples)).rejects.toThrow(/not given/);
    }
  });

  it("CLEAN TWIN: the same samples, a draft in its own words with only its own link", async () => {
    harness.replies.push(CLEAN);
    expect(await generateDunningEmail(env, withSamples)).toEqual(CLEAN);
  });
});

describe("stock phrasing", () => {
  const dunning = { merchant: { merchantName: "Acme" }, stepType: "soft_1", declineCategory: "soft", amountFormatted: "$49.00", updateUrl: UPDATE_URL };
  const winback = { stepNumber: 1, offsetHours: 1, customerName: "Sam", planName: "Pro", cancelReason: null, brandVoice: null, senderName: "Acme", resubscribeUrl: UPDATE_URL };

  it("PLANT: a draft with stock phrasing is retried once, naming what it used, and the cleaner retry is kept", async () => {
    harness.replies.push(STOCK, CLEAN);
    const copy = await generateDunningEmail(env, dunning);
    expect(harness.calls).toHaveLength(2);
    expect(harness.calls[1].messages[0].content).toContain('"No hard feelings"');
    expect(copy).toEqual(CLEAN);
  });

  it("PLANT: when the retry is no better, the first draft is sent, not the template", async () => {
    harness.replies.push(STOCK, STOCK);
    const copy = await generateWinbackEmail(env, winback);
    expect(harness.calls).toHaveLength(2);
    expect(copy).toEqual(STOCK);
    expect(passesQualityGate(copy)).toBe(true);
  });

  it("PLANT: a timing retry that brings stock phrasing back is not kept", async () => {
    harness.replies.push(
      { subject: "Your Acme card failed today", bodyHtml: CLEAN.bodyHtml },
      { subject: "Your Acme card failed", bodyHtml: STOCK.bodyHtml },
    );
    const copy = await generateDunningEmail(env, dunning);
    expect(harness.calls).toHaveLength(2);
    expect(copy).toEqual({ subject: "Your Acme card failed now", bodyHtml: CLEAN.bodyHtml });
  });

  it("a phrase the merchant's own emails use is their voice, not stock", async () => {
    harness.replies.push(STOCK);
    const copy = await generateDunningEmail(env, {
      ...dunning,
      merchant: { merchantName: "Acme", voiceSamples: ["Hi all, no hard feelings if you skip a month, we genuinely mean it. Cheers, Jo"] },
    });
    expect(harness.calls).toHaveLength(1);
    expect(copy).toEqual(STOCK);
  });

  it("CLEAN TWIN: a plainly written draft passes with no retry", async () => {
    harness.replies.push(CLEAN);
    const copy = await generateDunningEmail(env, dunning);
    expect(harness.calls).toHaveLength(1);
    expect(findBrandVoiceViolations(copy)).toEqual([]);
  });

  it("PLANT: dispute evidence that reads as machine-written is retried, and the plain retry is what Stripe gets", async () => {
    harness.replies.push(
      { uncategorizedText: "The customer genuinely had access to the plan, and that's completely fine by us." },
      { uncategorizedText: "The customer used the plan from 3 March." },
    );
    const fields = await draftDisputeEvidence(env, { productName: "Pro", serviceDate: null, communications: [] });
    expect(harness.calls).toHaveLength(2);
    expect(fields.find((f) => f.fieldName === "uncategorized_text")?.fieldValue).toBe("The customer used the plan from 3 March.");
  });
});
