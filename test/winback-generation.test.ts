import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createInMemoryDb } from "./helpers/inmemory-db";

// SESSION 58: the win-back AI half, which 346 named as REMAINING rather than
// hiding in a green suite.
//
// THE MODEL IS STUBBED AT THE FETCH SEAM, which is 347's method: the factory
// builds a real SDK client, so replacing globalThis.fetch proves the request
// that actually leaves rather than a constructor argument.

const harness = vi.hoisted(() => ({
  db: null as unknown,
  emailJobs: [] as Record<string, unknown>[],
  requests: [] as { url: string; body: Record<string, unknown> }[],
  reply: null as null | { subject: string; bodyHtml: string },
  fail: false,
}));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

vi.mock("~/lib/email/dispatch", () => ({
  processEmailJob: async (_env: unknown, job: Record<string, unknown>) => {
    harness.emailJobs.push(job);
    return { status: "sent" };
  },
}));

const { runWinbackSends, resolveWinbackCopy } = await import("~/lib/cron/winback");
const { buildWinbackPrompt, WINBACK_VOICE_FALLBACK } = await import(
  "~/lib/recovery/winback-generation"
);
const { buildWinbackEmail } = await import("~/lib/recovery/winback-email");
const { signCardUpdateToken, verifyCardUpdateToken } = await import("~/lib/card-update/token");

/** The link is LIVE, so a test that refuses it proves a mismatch, not expiry. */
async function expectLive(link: string): Promise<void> {
  expect(await verifyCardUpdateToken(env, link.split("/p/")[1])).not.toBeNull();
}

const ACCOUNT = "acct_1";
const NOW = new Date("2026-11-02T12:00:00Z");
const DUE = new Date("2026-11-02T11:00:00Z");
const env = {
  ENCRYPTION_KEY: "ab".repeat(32),
  ANTHROPIC_API_KEY: "sk-ant-test",
  BETTER_AUTH_URL: "https://foxhoundapp.test",
  PHYSICAL_ADDRESS: "1 Test Way",
} as unknown as Env;

let sqlite: Database.Database;
let db: ReturnType<typeof createInMemoryDb>["db"];
let realFetch: typeof globalThis.fetch;

beforeEach(() => {
  ({ sqlite, db } = createInMemoryDb());
  harness.db = db;
  harness.emailJobs = [];
  harness.requests = [];
  harness.reply = {
    subject: "We miss you",
    bodyHtml: '<p>Come back when you like.</p><p><a href="{{LINK}}">Reactivate</a></p>',
  };
  harness.fail = false;
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    harness.requests.push({
      url: typeof input === "string" ? input : String(input),
      body: JSON.parse(String(init?.body ?? "{}")),
    });
    if (harness.fail) return new Response("boom", { status: 500 });
    return new Response(
      JSON.stringify({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5",
        content: [{ type: "text", text: JSON.stringify(withMintedLink(harness.reply)) }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof globalThis.fetch;
  seed();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

/** The stub model writes `{{LINK}}` where a real model would write the link it
 *  was given, so a reply can carry the minted link, drop it, or rewrite it. The
 *  link is read off the prompt that actually left. */
function withMintedLink(reply: { subject: string; bodyHtml: string } | null) {
  if (!reply) return reply;
  const prompt =
    (harness.requests.at(-1)?.body as { messages?: { content: string }[] } | undefined)
      ?.messages?.[0]?.content ?? "";
  const link = /linking to: (\S+)/.exec(prompt)?.[1] ?? "";
  return { ...reply, bodyHtml: reply.bodyHtml.replaceAll("{{LINK}}", link) };
}

function seed(opts: { brandVoice?: string | null; cancelReason?: string | null } = {}): void {
  sqlite
    .prepare(
      "INSERT INTO accounts (id, name, created_at, processing_paused, live_sends_enabled) VALUES (?, 'Acme', 1000, 0, 1)",
    )
    .run(ACCOUNT);
  sqlite
    .prepare(
      "INSERT INTO stripe_connections (id, account_id, stripe_user_id, is_primary, stripe_access_token, sender_name, brand_voice, connected_at, created_at) VALUES ('c1', ?, 'acct_s', 1, 'cipher', 'Teamflow', ?, 1000, 1000)",
    )
    .run(ACCOUNT, opts.brandVoice === undefined ? "Dry and direct" : opts.brandVoice);
  sqlite
    .prepare(
      "INSERT INTO win_back_sequences (id, account_id, stripe_customer_id, stripe_subscription_id, customer_email, customer_name, plan_name, amount_cents, currency, cancel_reason, status, created_at, stripe_connection_id) VALUES ('wb_1', ?, 'cus_1', 'sub_1', 'b@a.test', 'Jane', 'Pro', 4900, 'usd', ?, 'active', 1000, 'c1')",
    )
    .run(ACCOUNT, opts.cancelReason === undefined ? "too expensive" : opts.cancelReason);
}

function seedStep(stepNumber = 1): void {
  sqlite
    .prepare(
      "INSERT INTO win_back_steps (id, win_back_sequence_id, account_id, step_number, scheduled_at, attempt_count) VALUES ('st_1', 'wb_1', ?, ?, ?, 0)",
    )
    .run(ACCOUNT, stepNumber, DUE.getTime());
}

function stepRow() {
  return sqlite
    .prepare(
      "SELECT result, ai_subject AS aiSubject, ai_body_html AS aiBody FROM win_back_steps WHERE id = 'st_1'",
    )
    .get() as { result: string | null; aiSubject: string | null; aiBody: string | null };
}

/** A resubscribe link minted four days BEFORE the real now, as an earlier tick
 *  would have minted it. Relative to the real clock, never a fixed date: a
 *  fixed mint date expires 30 days later (CARD_UPDATE_TOKEN_MAX_AGE_MS) and
 *  turns every test that relies on a live link red on that day. */
async function resubscribeLink(opts: {
  sequenceId: string;
  stepNumber: number;
  accountId?: string;
}): Promise<string> {
  const fourDaysAgo = Date.now() - 4 * 24 * 60 * 60 * 1000;
  const clock = vi.spyOn(Date, "now").mockReturnValue(fourDaysAgo);
  const token = await signCardUpdateToken(env, {
    winBackSequenceId: opts.sequenceId,
    winBackStepNumber: opts.stepNumber,
    accountId: opts.accountId ?? ACCOUNT,
  });
  clock.mockRestore();
  return `https://foxhoundapp.test/p/${token}`;
}

/** The href values of a body. */
/** The template's button targets (J91: the template is Capsomer's blocks). */
function buttonUrls(blocks: { type: string; url?: string }[]): string[] {
  return blocks.flatMap((b) => (b.type === "button" && b.url ? [b.url] : []));
}

/** Every link a sent job carries: the hrefs of an HTML body (generated or
 *  cached copy), or the buttons of the template's blocks (J91). */
function jobLinks(job: Record<string, unknown>): string[] {
  return Array.isArray(job.blocks)
    ? buttonUrls(job.blocks as { type: string; url?: string }[])
    : hrefs(String(job.bodyHtml));
}

function hrefs(html: string): string[] {
  return [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
}

/** The link the tick minted, read off the prompt that left. */
function mintedLink(): string {
  return /linking to: (\S+)/.exec(sentPrompt())?.[1] ?? "";
}

/** The prompt as it actually left, read off the stubbed request. */
function sentPrompt(): string {
  const body = harness.requests[0]?.body as { messages?: { content: string }[] } | undefined;
  return body?.messages?.[0]?.content ?? "";
}

describe("PLANT 1: the prompt is legacy's, per step", () => {
  const base = {
    offsetHours: 1,
    customerName: "Jane",
    planName: "Pro",
    cancelReason: "too expensive",
    brandVoice: "Dry and direct",
    senderName: "Teamflow",
    resubscribeUrl: "https://foxhoundapp.test/p/tok",
  };

  it("carries the customer, the plan and the cancellation reason", () => {
    const p = buildWinbackPrompt({ ...base, stepNumber: 2 });
    expect(p).toContain("- Name: Jane");
    expect(p).toContain("- Cancelled plan: Pro");
    expect(p).toContain("- Cancellation reason: too expensive");
  });

  it("THE VOICE IS THE GENERAL ONE, with legacy's own fallback", () => {
    expect(buildWinbackPrompt({ ...base, stepNumber: 1 })).toContain(
      "- Brand voice: Dry and direct",
    );
    expect(buildWinbackPrompt({ ...base, stepNumber: 1, brandVoice: null })).toContain(
      `- Brand voice: ${WINBACK_VOICE_FALLBACK}`,
    );
    expect(WINBACK_VOICE_FALLBACK).toBe("friendly and conversational");
  });

  it("carries the resubscribe link and the sender", () => {
    const p = buildWinbackPrompt({ ...base, stepNumber: 1 });
    expect(p).toContain(
      "- Include a reactivation button linking to: https://foxhoundapp.test/p/tok",
    );
    expect(p).toContain("- Sender name: Teamflow");
  });
});

describe("PLANT 2: a live generation sends the model's copy", () => {
  it("SENDS AI COPY and records legacy's email_sent_ai", async () => {
    seedStep();

    const result = await runWinbackSends(env, NOW);

    expect(result).toEqual({ sent: 1, skipped: 0 });
    expect(harness.emailJobs).toHaveLength(1);
    expect(harness.emailJobs[0].subject).toBe("We miss you");
    expect(String(harness.emailJobs[0].bodyHtml)).toContain("Come back when you like.");
    expect(stepRow().result).toBe("email_sent_ai");
  });

  it("THE PROMPT THAT LEFT CARRIES THE VOICE AND THE REASON FROM THE DATABASE", async () => {
    seedStep();

    await runWinbackSends(env, NOW);

    const prompt = sentPrompt();
    expect(prompt).toContain("- Brand voice: Dry and direct");
    expect(prompt).toContain("- Cancellation reason: too expensive");
    expect(prompt).toContain("- Name: Jane");
  });

  it("the copy is CACHED on the step before the send, as legacy caches it", async () => {
    seedStep();

    await runWinbackSends(env, NOW);

    const row = stepRow();
    expect(row.aiSubject).toBe("We miss you");
    expect(row.aiBody).toContain("Come back when you like.");
  });

  it("A CACHED STEP DOES NOT CALL THE MODEL AGAIN", async () => {
    seedStep();
    // The cached body carries the link an earlier tick minted for this step,
    // which is what a cached body written by resolveWinbackCopy carries.
    const link = await resubscribeLink({ sequenceId: "wb_1", stepNumber: 1 });
    await expectLive(link);
    sqlite
      .prepare(
        "UPDATE win_back_steps SET ai_subject = 'Cached subject', ai_body_html = ? WHERE id = 'st_1'",
      )
      .run(`<p>Cached body. <a href="${link}">Reactivate</a></p>`);

    await runWinbackSends(env, NOW);

    expect(harness.requests).toEqual([]);
    expect(harness.emailJobs[0].subject).toBe("Cached subject");
    expect(stepRow().result).toBe("email_sent_ai");
  });
});

describe("PLANT 3: every failure falls back to the template", () => {
  it("NO API KEY sends the template and records the fallback, QUIETLY", async () => {
    seedStep();
    // The key guard's observable effect is the ABSENCE of an error log. Without
    // it the factory throws, the catch below still falls back, and every step
    // would log a generation failure on an account that simply has no key,
    // which is Foxhound's standing state today (launch blocker 2).
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await runWinbackSends(
      { ...env, ANTHROPIC_API_KEY: undefined } as unknown as Env,
      NOW,
    );

    expect(result.sent).toBe(1);
    expect(harness.requests).toEqual([]);
    expect(harness.emailJobs[0].subject).toBe(
      "We're sorry to see you go. Here's what you're missing.",
    );
    expect(stepRow().result).toBe("email_sent_fallback");
    expect(logged).not.toHaveBeenCalled();
    logged.mockRestore();
  });

  it("A MODEL FAILURE sends the template and records the fallback", async () => {
    seedStep();
    harness.fail = true;

    const result = await runWinbackSends(env, NOW);

    expect(result.sent).toBe(1);
    expect(harness.requests.length).toBeGreaterThanOrEqual(1);
    expect(harness.emailJobs[0].subject).toBe(
      "We're sorry to see you go. Here's what you're missing.",
    );
    expect(stepRow().result).toBe("email_sent_fallback");
    expect(stepRow().aiSubject).toBeNull();
  });

  it("A WIDE DASH IS STRIPPED BY sanitizeCopy, so it never reaches the gate", async () => {
    seedStep();
    // Written as an escape: emitting the character by hand reproduces the thing
    // the hook exists to remove (332 binding 2).
    harness.reply = {
      subject: "We miss you",
      bodyHtml: '<p>Come back \u2014 please. <a href="{{LINK}}">Reactivate</a></p>',
    };

    await runWinbackSends(env, NOW);

    // The copy SENDS, with the dash gone. This is the sanitizer, not the gate.
    expect(stepRow().result).toBe("email_sent_ai");
    expect(String(harness.emailJobs[0].bodyHtml)).not.toMatch(/[\u2014\u2013]/);
  });

  it("COPY THAT FAILS THE QUALITY GATE IS NOT SENT", async () => {
    seedStep();
    // A TIMING LEAK is the violation that reaches the gate. The module says so
    // itself: "Post-sanitizeCopy, em_dash/ai_tell should be clear; timing_leak
    // is the detector that a sanitizer cannot safely fix." A dash fixture went
    // green here for exactly that reason.
    harness.reply = {
      subject: "We miss you",
      bodyHtml: "<p>It has been 3 days since you cancelled.</p>",
    };

    await runWinbackSends(env, NOW);

    expect(harness.emailJobs[0].subject).toBe(
      "We're sorry to see you go. Here's what you're missing.",
    );
    expect(stepRow().result).toBe("email_sent_fallback");
    expect(stepRow().aiSubject).toBeNull();
  });

  it("THE GATE IS REACHED ALONE, through resolveWinbackCopy", async () => {
    seedStep();
    harness.reply = { subject: "We miss you", bodyHtml: "<p>Your day 3 reminder.</p>" };

    const copy = await resolveWinbackCopy(
      env,
      db,
      {
        stepId: "st_1",
        sequenceId: "wb_1",
        accountId: ACCOUNT,
        stepNumber: 1,
        customerEmail: "b@a.test",
        customerName: "Jane",
        planName: "Pro",
        amountCents: 4900,
        notificationsEnabled: null,
        senderName: "Teamflow",
        cancelReason: "too expensive",
        brandVoice: "Dry",
        cachedSubject: null,
        cachedBodyHtml: null,
        replyToEmail: null,
        scheduledAt: new Date(3_601_000),
        sequenceCreatedAt: new Date(1000),
      },
      "https://foxhoundapp.test/p/tok",
    );

    expect(copy.result).toBe("email_sent_fallback");
  });
});

describe("PLANT 5: no win-back email leaves without its resubscribe link", () => {
  const LOSERS: { name: string; bodyHtml: string }[] = [
    { name: "drops the link", bodyHtml: "<p>Come back when you like.</p>" },
    {
      name: "invents a link",
      bodyHtml: '<p><a href="https://foxhoundapp.test/pricing">Reactivate</a></p>',
    },
    {
      name: "rewrites the host",
      bodyHtml: '<p><a href="{{LINK}}">Reactivate</a></p>'.replace(
        "{{LINK}}",
        "https://example.com/p/abc.def",
      ),
    },
    { name: "prints the link without linking it", bodyHtml: "<p>Come back: {{LINK}}</p>" },
  ];

  for (const loser of LOSERS) {
    it(`AI COPY THAT ${loser.name.toUpperCase()} sends the template with the minted link`, async () => {
      seedStep();
      harness.reply = { subject: "We miss you", bodyHtml: loser.bodyHtml };

      const result = await runWinbackSends(env, NOW);

      expect(result.sent).toBe(1);
      expect(harness.emailJobs[0].subject).toBe(
        "We're sorry to see you go. Here's what you're missing.",
      );
      const minted = mintedLink();
      expect(minted).toMatch(/^https:\/\/foxhoundapp\.test\/p\//);
      expect(jobLinks(harness.emailJobs[0])).toContain(minted);
      expect(stepRow().result).toBe("email_sent_fallback");
      // The linkless copy is not cached for the next tick to reuse.
      expect(stepRow().aiSubject).toBeNull();
    });
  }

  it("AI copy carrying the minted link is sent as written", async () => {
    seedStep();

    await runWinbackSends(env, NOW);

    expect(stepRow().result).toBe("email_sent_ai");
    expect(jobLinks(harness.emailJobs[0])).toContain(mintedLink());
  });

  it("A CACHED BODY WITHOUT THE LINK is replaced by the template", async () => {
    seedStep();
    sqlite
      .prepare(
        "UPDATE win_back_steps SET ai_subject = 'Cached subject', ai_body_html = '<p>Cached body.</p>' WHERE id = 'st_1'",
      )
      .run();

    await runWinbackSends(env, NOW);

    expect(harness.emailJobs[0].subject).toBe(
      "We're sorry to see you go. Here's what you're missing.",
    );
    expect(jobLinks(harness.emailJobs[0]).some((u) => u.startsWith("https://foxhoundapp.test/p/"))).toBe(true);
    expect(stepRow().result).toBe("email_sent_fallback");
  });

  it("A CACHED BODY LINKING ANOTHER STEP'S RESUBSCRIBE is replaced by the template", async () => {
    seedStep(1);
    const wrong = await resubscribeLink({ sequenceId: "wb_1", stepNumber: 2 });
    await expectLive(wrong);
    sqlite
      .prepare("UPDATE win_back_steps SET ai_subject = 'Cached subject', ai_body_html = ? WHERE id = 'st_1'")
      .run(`<p><a href="${wrong}">Reactivate</a></p>`);

    await runWinbackSends(env, NOW);

    expect(harness.emailJobs[0].subject).not.toBe("Cached subject");
    expect(jobLinks(harness.emailJobs[0])).not.toContain(wrong);
  });

  it("A CACHED BODY LINKING ANOTHER SEQUENCE is replaced by the template", async () => {
    seedStep(1);
    const wrong = await resubscribeLink({ sequenceId: "wb_other", stepNumber: 1 });
    await expectLive(wrong);
    sqlite
      .prepare("UPDATE win_back_steps SET ai_subject = 'Cached subject', ai_body_html = ? WHERE id = 'st_1'")
      .run(`<p><a href="${wrong}">Reactivate</a></p>`);

    await runWinbackSends(env, NOW);

    expect(harness.emailJobs[0].subject).not.toBe("Cached subject");
  });

  it("THE TEMPLATE CARRIES THE LINK on every step, and on an unknown step", () => {
    const url = "https://foxhoundapp.test/p/token.sig";
    for (const stepNumber of [1, 2, 3, 99]) {
      const body = buildWinbackEmail({
        stepNumber,
        customerName: null,
        planName: null,
        senderName: null,
        resubscribeUrl: url,
      });
      expect(buttonUrls(body), `step ${stepNumber}`).toContain(url);
    }
  });

  it("THE CHECK IS REACHED ALONE, through resolveWinbackCopy", async () => {
    seedStep();
    harness.reply = { subject: "We miss you", bodyHtml: "<p>Come back when you like.</p>" };

    const copy = await resolveWinbackCopy(
      env,
      db,
      {
        stepId: "st_1",
        sequenceId: "wb_1",
        accountId: ACCOUNT,
        stepNumber: 1,
        customerEmail: "b@a.test",
        customerName: "Jane",
        planName: "Pro",
        amountCents: 4900,
        notificationsEnabled: null,
        senderName: "Teamflow",
        cancelReason: "too expensive",
        brandVoice: "Dry",
        cachedSubject: null,
        cachedBodyHtml: null,
        replyToEmail: null,
        scheduledAt: new Date(3_601_000),
        sequenceCreatedAt: new Date(1000),
      },
      "https://foxhoundapp.test/p/tok",
    );

    expect(copy.result).toBe("email_sent_fallback");
    expect(buttonUrls(copy.blocks ?? [])).toContain("https://foxhoundapp.test/p/tok");
  });
});
