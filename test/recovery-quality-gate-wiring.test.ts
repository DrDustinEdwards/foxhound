import { describe, expect, it } from "vitest";

import {
  TEMPLATE_LABEL_FALLBACK,
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
    }
  });
});

describe("the gate polices the model, not the merchant", () => {

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
