import type Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";

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

  it("an OK scope still renders its numbers, so the absence is not everywhere", () => {
    // BOTH DIRECTIONS: a builder that printed "could not be read" for everything
    // would pass the assertion above.
    const prompt = buildAuditSummaryPrompt(auditWith({ disputes: failedRead("gone") }));
    expect(prompt).toContain("MRR: $0.00, ARR: $0.00, active subs: 0");
  });
});

describe("PLANT 3: the fallback", () => {

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
