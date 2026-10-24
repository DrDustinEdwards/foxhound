import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// JOB J01: no recovery or win-back email says WHEN the customer is reading it.
//
// Legacy Recova guards this in four layers (lib/email-generation.ts blob
// `e28d780e` lines 78 to 101 and 139; app/lib/recovery-execution.ts blob
// `3a8f8768` lines 313 to 351; process-winback blob `18f20de9` lines 393 to
// 404): a prompt rule, a nine-phrase detector, one retry when the SUBJECT
// leaks, and a hard strip of whatever still leaks. These plants prove each
// layer on both seams.
//
// THE MODEL IS STUBBED AT THE CLIENT FACTORY, the pattern
// audit-summary-phase-c uses: every seam builds its client through
// createAnthropicClient, so replacing the factory scripts each reply in order
// and records every request that would have left.

type Reply = { subject: string; bodyHtml: string } | Error;

const harness = vi.hoisted(() => ({
  calls: [] as { system?: unknown; messages: { role: string; content: string }[] }[],
  replies: [] as ({ subject: string; bodyHtml: string } | Error)[],
}));

vi.mock("~/lib/ai/client", () => ({
  createAnthropicClient: () => ({
    messages: {
      create: async (params: {
        system?: unknown;
        messages: { role: string; content: string }[];
      }) => {
        harness.calls.push(params);
        const next = harness.replies.shift();
        if (!next) throw new Error("no stub reply queued");
        if (next instanceof Error) throw next;
        return { content: [{ type: "text", text: JSON.stringify(next) }] };
      },
    },
  }),
}));

const {
  TIMING_RETRY_INSTRUCTION,
  buildPrompts,
  findBrandVoiceViolations,
  generateDunningEmail,
  hardStripTimingWords,
  hasTimingWord,
  passesQualityGate,
} = await import("~/lib/recovery/email-generation");
const { buildWinbackPrompt, generateWinbackEmail } = await import(
  "~/lib/recovery/winback-generation"
);

/** Legacy's nine phrases, in the order its regex names them. */
const NINE = [
  "today",
  "tonight",
  "yesterday",
  "this morning",
  "this afternoon",
  "this evening",
  "right now",
  "immediately",
  "by end of day",
] as const;

const env = { ANTHROPIC_API_KEY: "sk-ant-test" } as unknown as Env;

// One link for both seams: a draft may link only the URL its prompt was given.
const LINK = "https://foxhoundapp.test/u/today-1";

const DUNNING_INPUT = {
  merchant: { merchantName: "Acme" },
  stepType: "soft_1",
  declineCategory: "soft",
  amountFormatted: "$49.00",
  updateUrl: LINK,
};

const WINBACK_INPUT = {
  stepNumber: 1,
  offsetHours: 1,
  customerName: "Jane",
  planName: "Pro",
  cancelReason: "too expensive",
  brandVoice: "Dry and direct",
  senderName: "Teamflow",
  resubscribeUrl: LINK,
};

const CLEAN_BODY = `<p>Your card did not go through. <a href="${LINK}">Update it here</a>.</p>`;

function queue(...replies: Reply[]): void {
  harness.replies.push(...replies);
}

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  harness.calls = [];
  harness.replies = [];
});

describe("LAYER 2: the detector catches each of legacy's nine phrases", () => {

  it.each(NINE)("'%s' in the SUBJECT is caught by the detector and the gate", (phrase) => {
    const copy = { subject: `Update your card ${phrase}`, bodyHtml: CLEAN_BODY };
    expect(hasTimingWord(copy.subject)).toBe(true);
    expect(findBrandVoiceViolations(copy)).toContain("timing_leak");
    expect(passesQualityGate(copy)).toBe(false);
  });

  it("a timing word INSIDE A TAG is not a leak: an href token is never read", () => {
    const copy = {
      subject: "Your Acme payment needs a quick fix",
      bodyHtml: '<p><a href="https://x.example.com/u/today-123" title="tonight">Update it</a></p>',
    };
    expect(hasTimingWord(copy.bodyHtml)).toBe(false);
    expect(findBrandVoiceViolations(copy)).toEqual([]);
  });
});

describe("LAYER 4: hardStripTimingWords", () => {

  it("ports legacy's replacements in order", () => {
    expect(hardStripTimingWords("Your trial closes tonight")).toBe("Your trial will close soon");
    expect(hardStripTimingWords("Your access ends today")).toBe("Your access is ending");
    expect(hardStripTimingWords("Fix it by end of day")).toBe("Fix it soon");
    expect(hardStripTimingWords("Fix it today")).toBe("Fix it now");
    expect(hardStripTimingWords("Fix it right now")).toBe("Fix it now");
    expect(hardStripTimingWords("Fix it immediately.")).toBe("Fix it.");
    expect(hardStripTimingWords("It failed yesterday, sorry")).toBe("It failed, sorry");
    expect(hardStripTimingWords("We noticed this morning that it failed")).toBe(
      "We noticed that it failed",
    );
  });

  it("leaves clean text byte for byte", () => {
    const clean = "<p>Hi  there,\n\nyour card did not go through .</p>";
    expect(hardStripTimingWords(clean)).toBe(clean);
  });
});

/** Both seams, driven the same way. `firstUser` is the user message the first
 *  call must carry, so the retry is proven to be the SAME prompt plus legacy's
 *  instruction. */
const SEAMS = [
  {
    name: "dunning (generateDunningEmail)",
    run: () => generateDunningEmail(env, DUNNING_INPUT),
    firstUser: () => buildPrompts(DUNNING_INPUT).user,
  },
  {
    name: "win-back (generateWinbackEmail)",
    run: () => generateWinbackEmail(env, WINBACK_INPUT),
    firstUser: () => buildWinbackPrompt(WINBACK_INPUT),
  },
] as const;

describe.each(SEAMS)("LAYERS 3 and 4 on the $name seam", (seam) => {
  it("a clean first response makes EXACTLY ONE call", async () => {
    queue({ subject: "Your Acme payment needs a quick fix", bodyHtml: CLEAN_BODY });

    const copy = await seam.run();

    expect(harness.calls).toHaveLength(1);
    expect(copy.subject).toBe("Your Acme payment needs a quick fix");
    expect(copy.bodyHtml).toBe(CLEAN_BODY);
  });

  it("a SUBJECT leak with a clean retry: two calls, the retry's copy, legacy's instruction", async () => {
    queue(
      { subject: "Fix your payment today", bodyHtml: "<p>first body</p>" },
      { subject: "Your payment needs a quick fix", bodyHtml: "<p>retry body</p>" },
    );

    const copy = await seam.run();

    expect(harness.calls).toHaveLength(2);
    expect(copy).toEqual({
      subject: "Your payment needs a quick fix",
      bodyHtml: "<p>retry body</p>",
    });
    const firstUser = harness.calls[0].messages[0].content;
    const retryUser = harness.calls[1].messages[0].content;
    expect(firstUser).toBe(seam.firstUser());
    expect(retryUser).toBe(seam.firstUser() + TIMING_RETRY_INSTRUCTION);
    expect(retryUser).toContain("ADDITIONAL INSTRUCTION:");
    // The same system prompt (or none, on win-back) goes out both times.
    expect(harness.calls[1].system).toEqual(harness.calls[0].system);
  });

  it("first AND retry leak: two calls, never three, and both fields are hard-stripped", async () => {
    queue(
      { subject: "Fix it today", bodyHtml: "<p>Please update tonight.</p>" },
      { subject: "Fix it right now", bodyHtml: "<p>Please update immediately.</p>" },
      { subject: "never asked for", bodyHtml: "<p>never asked for</p>" },
    );

    const copy = await seam.run();

    expect(harness.calls).toHaveLength(2);
    expect(hasTimingWord(copy.subject)).toBe(false);
    expect(hasTimingWord(copy.bodyHtml)).toBe(false);
    expect(copy).toEqual({ subject: "Fix it now", bodyHtml: "<p>Please update.</p>" });
  });

  it("the retry THROWS: the first copy is kept, hard-stripped", async () => {
    queue(
      { subject: "Fix it today", bodyHtml: "<p>Update yesterday's card.</p>" },
      new Error("model outage"),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});

    const copy = await seam.run();

    expect(harness.calls).toHaveLength(2);
    expect(copy.subject).toBe("Fix it now");
    expect(hasTimingWord(copy.bodyHtml)).toBe(false);
  });

  it("the retry returns NOTHING USABLE: the first copy is kept, hard-stripped", async () => {
    queue(
      { subject: "Fix it today", bodyHtml: "<p>first body</p>" },
      { subject: "", bodyHtml: "" },
    );

    const copy = await seam.run();

    expect(harness.calls).toHaveLength(2);
    expect(copy).toEqual({ subject: "Fix it now", bodyHtml: "<p>first body</p>" });
  });

  it("a BODY-only leak: one call, the body hard-stripped, the subject untouched", async () => {
    queue({
      subject: "Your Acme payment needs a quick fix",
      bodyHtml: '<p>Please fix it today. <a href="https://foxhoundapp.test/u/today-1">Update</a></p>',
    });

    const copy = await seam.run();

    expect(harness.calls).toHaveLength(1);
    expect(copy.subject).toBe("Your Acme payment needs a quick fix");
    expect(copy.bodyHtml).toBe(
      '<p>Please fix it now. <a href="https://foxhoundapp.test/u/today-1">Update</a></p>',
    );
  });

  it("a first-call failure still throws, so the caller sends the template (RULES.md 3.15)", async () => {
    queue(new Error("model outage"));

    await expect(seam.run()).rejects.toThrow("model outage");
    expect(harness.calls).toHaveLength(1);
  });
});
