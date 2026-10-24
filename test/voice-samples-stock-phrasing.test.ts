import { beforeEach, describe, expect, it, vi } from "vitest";

// The merchant's own past emails and the family's stock-phrasing check, an
// approved difference from Recova (parity/APPROVED-DIFFERENCES.md, 2026-10-24).
// The check itself is site-runtime ./prose's and is tested there; these hold
// Foxhound's part: the samples are saved, read and reach both prompts as data,
// and a draft with stock phrasing is retried once and kept from sending. The
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
const { buildPrompts, findBrandVoiceViolations, generateDunningEmail } = await import(
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
  bodyHtml: `<p>We want to ensure a seamless experience for you.</p><p><a href="${UPDATE_URL}">Update your card</a>.</p>`,
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

describe("stock phrasing", () => {
  const dunning = { merchant: { merchantName: "Acme" }, stepType: "soft_1", declineCategory: "soft", amountFormatted: "$49.00", updateUrl: UPDATE_URL };

  it("PLANT: a draft with stock phrasing is retried once, naming what it used, and the cleaner retry is kept", async () => {
    harness.replies.push(STOCK, CLEAN);
    const copy = await generateDunningEmail(env, dunning);
    expect(harness.calls).toHaveLength(2);
    expect(harness.calls[1].messages[0].content).toContain('"seamless"');
    expect(copy).toEqual(CLEAN);
  });

  it("PLANT: when the retry is no better, the gate keeps it from sending", async () => {
    harness.replies.push(STOCK, STOCK);
    const copy = await generateWinbackEmail(env, {
      stepNumber: 1,
      offsetHours: 1,
      customerName: "Sam",
      planName: "Pro",
      cancelReason: null,
      brandVoice: null,
      senderName: "Acme",
      resubscribeUrl: UPDATE_URL,
    });
    expect(harness.calls).toHaveLength(2);
    expect(findBrandVoiceViolations(copy)).toContain("stock_phrase");
  });

  it("CLEAN TWIN: a plainly written draft passes with no retry", async () => {
    harness.replies.push(CLEAN);
    const copy = await generateDunningEmail(env, dunning);
    expect(harness.calls).toHaveLength(1);
    expect(findBrandVoiceViolations(copy)).toEqual([]);
  });

  it("PLANT: dispute evidence that reads as machine-written is retried, and the plain retry is what Stripe gets", async () => {
    harness.replies.push(
      { uncategorizedText: "The customer had seamless access to the plan, a testament to our robust service." },
      { uncategorizedText: "The customer used the plan from 3 March." },
    );
    const fields = await draftDisputeEvidence(env, { productName: "Pro", serviceDate: null, communications: [] });
    expect(harness.calls).toHaveLength(2);
    expect(fields.find((f) => f.fieldName === "uncategorized_text")?.fieldValue).toBe("The customer used the plan from 3 March.");
  });
});
