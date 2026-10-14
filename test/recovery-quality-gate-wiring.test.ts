import { describe, expect, it } from "vitest";

import {
  TEMPLATE_LABEL_FALLBACK,
  TEMPLATE_LABEL_GENERATED,
  buildEngagementUrls,
  executeEmailStep,
  type EmailStepContext,
} from "~/lib/engine/execute-step";
import type { EmailJob } from "~/lib/email/types";
import type { EmailJobResult } from "~/lib/email/dispatch";
import { findBrandVoiceViolations, type EmailCopy } from "~/lib/recovery/email-generation";

// Part 1: the brand-voice quality gate, wired into the send path.
//
// Before this, passesQualityGate and findBrandVoiceViolations were written, unit
// tested, and called by NOTHING in the send path. Dunning bodies are the only
// ungrounded AI output with no other backstop: disputes carry mandatory merchant
// approval, the Intelligence narrative is merchant-read-only, and these go to a
// merchant's own customers in that merchant's voice.

const env = {
  BETTER_AUTH_URL: "https://foxhoundapp.com",
  PHYSICAL_ADDRESS: "1 Test St, Austin TX",
  // Required by the card-update and engagement token signers, which run before
  // any copy resolution. Valid hex: hexToBytes does not validate, but a real key
  // is the honest fixture.
  ENCRYPTION_KEY: "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
} as unknown as Env;

function ctx(overrides: Partial<EmailStepContext> = {}): EmailStepContext {
  return {
    stepId: "step_1",
    accountId: "acct_1",
    failedPaymentId: "fp_1",
    stepType: "email_day1",
    attemptCount: 0,
    declineCategory: "soft",
    customerEmail: "customer@example.com",
    amountCents: 4900,
    currency: "usd",
    merchantName: "Teamflow",
    senderName: "Teamflow",
    voiceDescription: null,
    cached: { customBody: null, cachedSubject: null, cachedBodyHtml: null },
    ...overrides,
  };
}

/** A link of the kind the executor mints for this step, for copy that must
 *  carry one (a custom body or cached copy read back from the step row). */
async function stepLink(): Promise<string> {
  return (await buildEngagementUrls(env, ctx(), "https://foxhoundapp.com")).clickTrackedUpdateUrl;
}

async function runWithGenerated(copy: EmailCopy, context: Partial<EmailStepContext> = {}) {
  const jobs: EmailJob[] = [];
  const result = await executeEmailStep(env, ctx(context), {
    // `{{LINK}}` stands where a model writes the update link it was given, so
    // passing copy carries the link and the gate is the only thing under test.
    generate: async (_e, updateUrl) => ({
      subject: copy.subject,
      bodyHtml: copy.bodyHtml.replaceAll("{{LINK}}", updateUrl),
    }),
    send: (_e, job) => {
      jobs.push(job);
      return Promise.resolve({ status: "sent" } as EmailJobResult);
    },
    persistPatch: async () => {},
  });
  return { result, job: jobs[0] };
}

const CLEAN: EmailCopy = {
  subject: "A payment issue with Teamflow",
  bodyHtml: '<p>Your payment did not go through. You can <a href="{{LINK}}">update your card here</a>.</p>',
};

// One violating sample PER RULE CLASS, not one clean sample. Each of these is a
// distinct branch of findBrandVoiceViolations, and a gate that catches only em
// dashes would pass a test built from a single dashed string.
const VIOLATIONS: { name: string; copy: EmailCopy; expect: string }[] = [
  {
    name: "em_dash in body",
    copy: { subject: "Payment issue", bodyHtml: "<p>Your card failed — please update it.</p>" },
    expect: "em_dash",
  },
  {
    name: "en_dash in subject",
    copy: { subject: "Payment – action needed", bodyHtml: "<p>Please update your card.</p>" },
    expect: "em_dash",
  },
  {
    name: "ai_tell filler",
    copy: {
      subject: "Payment issue",
      bodyHtml: "<p>I hope this email finds you well. Your payment failed.</p>",
    },
    expect: "ai_tell",
  },
  {
    name: "ai_tell, another phrase",
    copy: {
      subject: "Payment issue",
      bodyHtml: "<p>Rest assured we are here. Please update your card.</p>",
    },
    expect: "ai_tell",
  },
  {
    name: "timing_leak, day N",
    copy: { subject: "Payment issue", bodyHtml: "<p>This is your day 3 reminder.</p>" },
    expect: "timing_leak",
  },
  {
    name: "timing_leak, hours ago",
    copy: { subject: "Payment issue", bodyHtml: "<p>Your payment failed 72 hours ago.</p>" },
    expect: "timing_leak",
  },
  {
    name: "timing_leak, since N days",
    copy: { subject: "Payment issue", bodyHtml: "<p>It has been failing since 3 days.</p>" },
    expect: "timing_leak",
  },
  {
    name: "empty subject",
    copy: { subject: "   ", bodyHtml: "<p>Please update your card.</p>" },
    expect: "empty",
  },
  {
    name: "empty body",
    copy: { subject: "Payment issue", bodyHtml: "" },
    expect: "empty",
  },
];

describe("the gate is actually wired into the send path", () => {
  it("sends generated copy that passes the gate", async () => {
    const { result, job } = await runWithGenerated(CLEAN);
    expect(result.usedTemplate).toBe(false);
    expect(result.templateReason).toBeNull();
    expect(job.subject).toBe(CLEAN.subject);
    expect(job.template).toBe(TEMPLATE_LABEL_GENERATED);
  });

  // Sweep every rule class. Each entry must (a) actually violate the rule it
  // claims, and (b) be replaced by the template in the send path.
  it("replaces violating copy with the template, for every rule class", async () => {
    for (const v of VIOLATIONS) {
      // The fixture must genuinely violate what it says it does, or this test
      // would pass while asserting nothing.
      expect(findBrandVoiceViolations(v.copy), `${v.name} fixture`).toContain(v.expect);

      const { result, job } = await runWithGenerated(v.copy);
      expect(result.usedTemplate, v.name).toBe(true);
      expect(result.templateReason, v.name).toBe("quality_gate");
      expect(job.template, v.name).toBe(TEMPLATE_LABEL_FALLBACK);
      // The violating text must not reach the customer.
      expect(job.bodyHtml, v.name).not.toContain("—");
      expect(job.bodyHtml, v.name).not.toContain("day 3");
      expect(job.bodyHtml, v.name).not.toMatch(/I hope this email finds you well/i);
    }
  });

  it("still reports the step as sent when the gate rejects: the step did not fail", async () => {
    const { result } = await runWithGenerated(VIOLATIONS[0].copy);
    expect(result.sent).toBe(true);
    expect(result.result).toBe("email_sent");
  });

  it("distinguishes a gate rejection from a generation failure in the reason", async () => {
    const gated = await runWithGenerated(VIOLATIONS[0].copy);
    expect(gated.result.templateReason).toBe("quality_gate");

    const jobs: EmailJob[] = [];
    const thrown = await executeEmailStep(env, ctx(), {
      generate: () => Promise.reject(new Error("anthropic 503")),
      send: (_e, job) => {
        jobs.push(job);
        return Promise.resolve({ status: "sent" } as EmailJobResult);
      },
      persistPatch: async () => {},
    });
    expect(thrown.templateReason).toBe("generation_failed");
    // Both use the same email_sends label; the distinction lives on the result.
    expect(jobs[0].template).toBe(TEMPLATE_LABEL_FALLBACK);
  });
});

describe("the gate polices the model, not the merchant", () => {
  // A merchant-authored custom body is their own voice and their own choice.
  // Rejecting it for an em dash would be the tool overruling the user, so the
  // gate runs on the GENERATED copy before applyCustomBody.
  it("keeps a merchant custom body containing an em dash", async () => {
    const link = await stepLink();
    const { job } = await runWithGenerated(CLEAN, {
      cached: {
        customBody: `<p>We tried your card — it did not work. Please <a href="${link}">update it</a>.</p>`,
        cachedSubject: null,
        cachedBodyHtml: null,
      },
    });
    expect(job.bodyHtml).toContain("—");
  });

  it("still falls back for the SUBJECT when generation violates and a custom body exists", async () => {
    const link = await stepLink();
    const { result, job } = await runWithGenerated(
      { subject: "Your day 3 reminder", bodyHtml: "<p>Generated body.</p>" },
      {
        cached: {
          customBody: `<p>Merchant body. <a href="${link}">Update</a></p>`,
          cachedSubject: null,
          cachedBodyHtml: null,
        },
      },
    );
    expect(result.templateReason).toBe("quality_gate");
    // Merchant body wins, template subject replaces the violating generated one.
    expect(job.bodyHtml).toContain("Merchant body.");
    expect(job.subject).not.toContain("day 3");
  });
});

describe("the gate does not touch cached copy", () => {
  // Cached copy already passed the gate when it was generated, and re-gating it
  // would let a rule change silently rewrite mail a customer already received.
  it("sends cached copy without gating or generating", async () => {
    const jobs: EmailJob[] = [];
    const result = await executeEmailStep(
      env,
      ctx({
        cached: {
          customBody: null,
          cachedSubject: "Cached — subject with a dash",
          cachedBodyHtml: `<p>Cached body. <a href="${await stepLink()}">Update</a></p>`,
        },
      }),
      {
        generate: () => Promise.reject(new Error("must not be called")),
        send: (_e, job) => {
          jobs.push(job);
          return Promise.resolve({ status: "sent" } as EmailJobResult);
        },
        persistPatch: async () => {},
      },
    );
    expect(result.usedTemplate).toBe(false);
    expect(result.templateReason).toBeNull();
    expect(jobs[0].subject).toContain("—");
  });
});
