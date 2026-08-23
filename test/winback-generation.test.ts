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
  harness.reply = { subject: "We miss you", bodyHtml: "<p>Come back when you like.</p>" };
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
        content: [{ type: "text", text: JSON.stringify(harness.reply) }],
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
});

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

/** The prompt as it actually left, read off the stubbed request. */
function sentPrompt(): string {
  const body = harness.requests[0]?.body as { messages?: { content: string }[] } | undefined;
  return body?.messages?.[0]?.content ?? "";
}

describe("PLANT 1: the prompt is legacy's, per step", () => {
  const base = {
    customerName: "Jane",
    planName: "Pro",
    cancelReason: "too expensive",
    brandVoice: "Dry and direct",
    senderName: "Teamflow",
    resubscribeUrl: "https://foxhoundapp.test/p/tok",
  };

  it("carries legacy's opening line and JSON contract", () => {
    const p = buildWinbackPrompt({ ...base, stepNumber: 1 });
    expect(p).toContain(
      "You are writing a win-back email for a SaaS business trying to re-engage a cancelled customer.",
    );
    expect(p).toContain("Respond ONLY in this exact JSON format with no preamble or markdown:");
  });

  it("STEP 3 DIFFERS, as legacy's step descriptions do", () => {
    const one = buildWinbackPrompt({ ...base, stepNumber: 1 });
    const three = buildWinbackPrompt({ ...base, stepNumber: 3 });

    expect(one).toContain("warm, empathetic, not pushy");
    expect(three).toContain("last chance, no pressure");
    expect(three).toContain("14 days after cancellation");
    expect(one).not.toContain("last chance");
  });

  it("carries the customer, the plan and the cancellation reason", () => {
    const p = buildWinbackPrompt({ ...base, stepNumber: 2 });
    expect(p).toContain("- Name: Jane");
    expect(p).toContain("- Cancelled plan: Pro");
    expect(p).toContain("- Cancellation reason: too expensive");
  });

  it("an absent reason reads legacy's `not provided`", () => {
    expect(buildWinbackPrompt({ ...base, stepNumber: 1, cancelReason: null })).toContain(
      "- Cancellation reason: not provided",
    );
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

  it("NO MERCHANT CONTEXT, because legacy's win-back select carries none", () => {
    const p = buildWinbackPrompt({ ...base, stepNumber: 1 });
    expect(p).not.toContain("Merchant context");
    expect(p).not.toContain("industry");
    expect(p).not.toContain("MRR");
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

  it("THE CALL SHAPE IS LEGACY'S: max_tokens 1000, not the dunning path's 2000", async () => {
    seedStep();

    await runWinbackSends(env, NOW);

    const body = harness.requests[0].body as { max_tokens?: number; model?: string };
    expect(body.max_tokens).toBe(1000);
    expect(body.model).toBe("claude-sonnet-5");
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
    sqlite
      .prepare(
        "UPDATE win_back_steps SET ai_subject = 'Cached subject', ai_body_html = '<p>Cached body.</p>' WHERE id = 'st_1'",
      )
      .run();

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
      bodyHtml: "<p>Come back \u2014 please.</p>",
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
      },
      "https://foxhoundapp.test/p/tok",
    );

    expect(copy.result).toBe("email_sent_fallback");
  });
});

describe("PLANT 4: the docs describe the copy", () => {
  it("the win-back section says the emails are written in the brand voice per step", async () => {
    const { DOC_GUIDES } = await import("~/lib/marketing/docs-content");
    const body = DOC_GUIDES.flatMap((g) => g.sections)
      .flatMap((s) => s.body)
      .join(" ");

    expect(body).toContain(
      "Each is written in your brand voice for the step it is, warmer at the first and lighter at the last",
    );
  });
});
