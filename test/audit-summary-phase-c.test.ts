import type Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";

import { AUDIT_SUMMARY_MAX_TOKENS, MODEL_AUDIT_SUMMARY } from "~/lib/constants";
import { runAudit, type AuditInputs, type ScopeOutcome } from "~/lib/audit/engine";
import {
  AUDIT_SUMMARY_FALLBACK,
  buildAuditSummaryPrompt,
  sanitizeSummary,
} from "~/lib/audit/summary";

// SESSION 69, PHASE (c): the audit's three-sentence summary.
//
// THE PROMPT IS LEGACY'S, ported as found from `generateAiSummary`. It is INPUT
// to a model rather than copy Foxhound authors, so it is not rewritten to house
// style. It carries no wide dash to remove; the only dash instruction in it is
// legacy telling the model not to use them, which is kept.
//
// THE ONE ADDITION IS THE HONEST ABSENCE. Legacy hands the model a 0 for a scope
// whose Stripe call failed, so the model writes a sentence about a merchant with
// no open disputes. Foxhound's per-scope status reaches the prompt as words.

const RAN_AT = new Date("2026-08-24T12:00:00.000Z");

const ok = <T>(data: T[]): ScopeOutcome<T[]> => ({ ok: true, data });
const failedRead = (reason: string): ScopeOutcome<never[]> => ({ ok: false, reason });

function auditWith(over: Partial<AuditInputs> = {}) {
  return runAudit({
    stripeAccountId: "acct_x",
    lookbackDays: 90,
    ranAt: RAN_AT,
    reads: {
      uncollectibleInvoices: ok<Stripe.Invoice>([]),
      openInvoices: ok<Stripe.Invoice>([]),
      subscriptions: ok<Stripe.Subscription>([]),
      disputes: ok<Stripe.Dispute>([]),
      cardUpdaterEvents: ok<Stripe.Event>([]),
      ...over,
    },
  });
}

const invoice = (o: Record<string, unknown>) =>
  ({ amount_due: 0, currency: "usd", ...o }) as unknown as Stripe.Invoice;

describe("PLANT 1: the prompt is legacy's, at the bytes", () => {
  const prompt = buildAuditSummaryPrompt(auditWith());

  it("carries legacy's instruction block verbatim", () => {
    expect(prompt).toContain(
      'You are writing a 3-sentence audit summary for a SaaS merchant. Do not use em dashes. Do not use bullet points. Do not use AI writing tells like "leverage", "unlock", "streamline". Reference specific dollar amounts from the data below.',
    );
  });

  it("carries legacy's three-sentence structure verbatim", () => {
    expect(prompt).toContain("STRUCTURE, exactly 3 sentences:");
    expect(prompt).toContain("1. The biggest revenue leak with its dollar amount.");
    expect(prompt).toContain("2. What Foxhound fixes automatically today.");
    expect(prompt).toContain("3. One forward-looking risk or opportunity.");
    expect(prompt).toContain("Return only the three sentences. No preamble. No list. No quotes.");
  });

  it("carries legacy's DATA labels, in legacy's order", () => {
    const labels = [
      "Failed invoices (last 90 days):",
      "Expiring cards in next 30 days:",
      "Past-due subscriptions:",
      "Open disputes:",
      "Disputes accepted without fighting:",
      "Dispute history:",
      "Card Updater (last 30 days):",
    ];
    let cursor = prompt.indexOf("DATA:");
    expect(cursor).toBeGreaterThan(-1);
    for (const label of labels) {
      const at = prompt.indexOf(label, cursor);
      expect(at, `${label} missing or out of order`).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  it("says Foxhound where legacy says Recova, and nowhere else", () => {
    expect(prompt).not.toContain("Recova");
    expect(prompt).toContain("What Foxhound fixes automatically today.");
  });

  it("CARRIES NO WIDE DASH, so the prompt cannot teach the model one", () => {
    expect(prompt).not.toContain(String.fromCharCode(0x2014));
    expect(prompt).not.toContain(String.fromCharCode(0x2013));
  });

  it("renders dollars at legacy's two decimals", () => {
    const withMoney = buildAuditSummaryPrompt(
      auditWith({ uncollectibleInvoices: ok<Stripe.Invoice>([invoice({ amount_due: 123_456 })]) }),
    );
    expect(withMoney).toContain("Failed invoices (last 90 days): $1234.56 across 1 invoices");
  });
});

describe("PLANT 2: a scope that could not be read says so", () => {
  it("A FAILED SCOPE REACHES THE PROMPT AS WORDS, never as a zero", () => {
    // THE DIVERGENCE, and the reason for it. Legacy would print
    // "Open disputes: $0.00 across 0 disputes" for a disputes call that failed,
    // and the model would then write a sentence about a merchant with none.
    const prompt = buildAuditSummaryPrompt(
      auditWith({ disputes: failedRead("Could not read disputes from Stripe: rate limited") }),
    );
    expect(prompt).toContain("Open disputes: could not be read");
    expect(prompt).toContain("Disputes accepted without fighting: could not be read");
    expect(prompt).toContain("Dispute history: could not be read");
    expect(prompt).not.toContain("across 0 disputes");
  });

  it("and the instruction tells the model what to do with that", () => {
    expect(buildAuditSummaryPrompt(auditWith())).toContain(
      "Where a line says it could not be read, say that scope is unavailable rather than reporting a number for it.",
    );
  });

  it("an OK scope still renders its numbers, so the absence is not everywhere", () => {
    // BOTH DIRECTIONS: a builder that printed "could not be read" for everything
    // would pass the assertion above.
    const prompt = buildAuditSummaryPrompt(auditWith({ disputes: failedRead("gone") }));
    expect(prompt).toContain("MRR: $0.00, ARR: $0.00, active subs: 0");
  });
});

describe("PLANT 3: the fallback", () => {
  it("is a static string, and it is Foxhound's promise rather than legacy's", () => {
    // Legacy returns a fixed paragraph with no key and again inside its catch. A
    // summary invented from the numbers by template would be a worse lie than a
    // general one, which is why both sides keep it static.
    expect(AUDIT_SUMMARY_FALLBACK).toContain("Foxhound handles recovery and dispute evidence");
    expect(AUDIT_SUMMARY_FALLBACK).toContain("bills only on what it recovers");
    expect(AUDIT_SUMMARY_FALLBACK).not.toContain("Recova");
    expect(AUDIT_SUMMARY_FALLBACK).not.toContain(String.fromCharCode(0x2014));
  });

  it("NO KEY YIELDS THE FALLBACK WITH A REASON, never a throw", async () => {
    const { generateAuditSummary } = await import("~/lib/audit/summary.server");
    const outcome = await generateAuditSummary({} as Env, auditWith());
    expect(outcome).toEqual({
      source: "fallback",
      summary: AUDIT_SUMMARY_FALLBACK,
      reason: "ANTHROPIC_API_KEY is not set",
    });
  });

  it("the outcome is DISCRIMINATED, so a caller cannot mistake the fallback for a reading", async () => {
    const { generateAuditSummary } = await import("~/lib/audit/summary.server");
    const outcome = await generateAuditSummary({} as Env, auditWith());
    expect(outcome.source).toBe("fallback");
    // Both arms carry a usable string, so no caller has to handle an absent one.
    expect(outcome.summary.length).toBeGreaterThan(50);
  });
});

describe("PLANT 4: the call, and what leaves through the factory", () => {
  it("sends legacy's model and legacy's token budget", async () => {
    // Legacy's MODEL_HAIKU_PINNED is 'claude-haiku-4-5-20251001'. Foxhound's
    // constant is the SAME STRING, so 353 binding 6 has nothing to rule on here.
    expect(MODEL_AUDIT_SUMMARY).toBe("claude-haiku-4-5-20251001");
    expect(AUDIT_SUMMARY_MAX_TOKENS).toBe(300);

    const create = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "One. Two. Three." }] });
    vi.doMock("~/lib/ai/client", () => ({ createAnthropicClient: () => ({ messages: { create } }) }));
    vi.resetModules();
    const { generateAuditSummary } = await import("~/lib/audit/summary.server");

    const outcome = await generateAuditSummary({ ANTHROPIC_API_KEY: "sk" } as unknown as Env, auditWith());
    expect(outcome).toEqual({ source: "model", summary: "One. Two. Three." });
    expect(create).toHaveBeenCalledWith({
      model: MODEL_AUDIT_SUMMARY,
      max_tokens: AUDIT_SUMMARY_MAX_TOKENS,
      messages: [{ role: "user", content: buildAuditSummaryPrompt(auditWith()) }],
    });
    vi.doUnmock("~/lib/ai/client");
    vi.resetModules();
  });

  it("A THROWN CALL FALLS BACK WITH THE REASON, and an EMPTY REPLY does too", async () => {
    vi.doMock("~/lib/ai/client", () => ({
      createAnthropicClient: () => ({
        messages: { create: () => Promise.reject(new Error("overloaded")) },
      }),
    }));
    vi.resetModules();
    const thrown = await (await import("~/lib/audit/summary.server")).generateAuditSummary(
      { ANTHROPIC_API_KEY: "sk" } as unknown as Env,
      auditWith(),
    );
    expect(thrown).toEqual({
      source: "fallback",
      summary: AUDIT_SUMMARY_FALLBACK,
      reason: "overloaded",
    });

    vi.doMock("~/lib/ai/client", () => ({
      createAnthropicClient: () => ({
        messages: { create: () => Promise.resolve({ content: [{ type: "text", text: "   " }] }) },
      }),
    }));
    vi.resetModules();
    const empty = await (await import("~/lib/audit/summary.server")).generateAuditSummary(
      { ANTHROPIC_API_KEY: "sk" } as unknown as Env,
      auditWith(),
    );
    // An empty reply is a failure wearing a success, so it takes the same arm.
    expect(empty).toEqual({
      source: "fallback",
      summary: AUDIT_SUMMARY_FALLBACK,
      reason: "the model returned no text",
    });
    vi.doUnmock("~/lib/ai/client");
    vi.resetModules();
  });
});

describe("PLANT 5: the reply is sanitized before it is ever stored", () => {
  it("wide dashes in the model's reply become commas", () => {
    // The one string in the repo nobody reviewed. Legacy strips the same two
    // characters for the same reason.
    const EM = String.fromCharCode(0x2014);
    const EN = String.fromCharCode(0x2013);
    expect(sanitizeSummary(`a${EM}b`)).toBe("a, b");
    expect(sanitizeSummary(`a${EN}b`)).toBe("a, b");
    expect(sanitizeSummary("  clean  ")).toBe("clean");
  });
});

describe("PLANT 6: the pure module writes nothing and calls nothing", () => {
  it("summary.ts reaches no database, no Stripe, no model", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const source = readFileSync(
      fileURLToPath(new URL("../app/lib/audit/summary.ts", import.meta.url)),
      "utf8",
    );
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    for (const forbidden of ["getDb", "createAnthropicClient", "recordOutcome", "await "]) {
      expect(code, `${forbidden} reached the pure prompt builder`).not.toContain(forbidden);
    }
  });
});
