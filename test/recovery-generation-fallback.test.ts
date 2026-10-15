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
import type { EmailCopy } from "~/lib/recovery/email-generation";
import type { StepStatePatch } from "~/lib/recovery/step-state";

// Part 2: a generation failure must fall back to the deterministic template, and
// genuine SEND failures must keep their existing backoff. Before this, both
// shared one catch block, so a model outage produced NO email and rescheduled the
// step, silently halting recovery for every affected merchant on every affected
// step. On a revenue-recovery product that is the wrong direction.

const env = {
  BETTER_AUTH_URL: "https://foxhoundapp.com",
  PHYSICAL_ADDRESS: "1 Test St, Austin TX",
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

interface Captured {
  jobs: EmailJob[];
  patches: { patch: StepStatePatch; cache?: EmailCopy }[];
}

/** Drive executeEmailStep with injected seams, capturing what it tried to send
 *  and persist. `generate` defaults to throwing, which is the outage case. */
async function run(opts: {
  generate?: (updateUrl: string) => Promise<EmailCopy>;
  send?: (job: EmailJob) => Promise<EmailJobResult>;
  context?: Partial<EmailStepContext>;
}) {
  const captured: Captured = { jobs: [], patches: [] };
  const result = await executeEmailStep(env, ctx(opts.context), {
    generate: opts.generate
      ? (_e, updateUrl) => opts.generate!(updateUrl)
      : () => Promise.reject(new Error("anthropic 503")),
    send:
      opts.send
        ? (_e, job) => {
            captured.jobs.push(job);
            return opts.send!(job);
          }
        : (_e, job) => {
            captured.jobs.push(job);
            return Promise.resolve({ status: "sent" } as EmailJobResult);
          },
    persistPatch: async (_e, _id, patch, cache) => {
      captured.patches.push({ patch, cache });
    },
  });
  return { result, captured };
}

describe("a generation failure sends the template instead of nothing", () => {
  // THE regression. Pre-fix this produced zero jobs and a backoff reschedule.
  it("still sends an email when generation throws", async () => {
    const { result, captured } = await run({});
    expect(captured.jobs).toHaveLength(1);
    expect(result.sent).toBe(true);
    expect(result.result).toBe("email_sent");
  });

  it("marks the send as a template fallback, not a generated send", async () => {
    const { result, captured } = await run({});
    expect(result.usedTemplate).toBe(true);
    expect(captured.jobs[0].template).toBe(TEMPLATE_LABEL_FALLBACK);
  });

  it("labels a normal generated send distinctly, so the fallback rate is queryable", async () => {
    const { result, captured } = await run({
      generate: async (url) => ({
        subject: "Quick note",
        bodyHtml: `<p>Please <a href="${url}">update your card</a>.</p>`,
      }),
    });
    expect(result.usedTemplate).toBe(false);
    expect(captured.jobs[0].template).toBe(TEMPLATE_LABEL_GENERATED);
  });

  it("does not record the generation error on the step: it did not fail", async () => {
    const { captured } = await run({});
    expect(captured.patches[0].patch.lastAttemptError).toBeNull();
    expect(captured.patches[0].patch.nextRetryAt).toBeNull();
  });

  it("sends template copy carrying the click-tracked CTA, not a bare card-update link", async () => {
    const { captured } = await run({});
    expect(captured.jobs[0].bodyHtml).toContain("/e/c/");
  });

  // Sweep the trigger, not one instance: any generation failure mode falls back.
  it("falls back for every generation failure mode", async () => {
    const failures: Record<string, () => Promise<EmailCopy>> = {
      throws_error: () => Promise.reject(new Error("anthropic 503")),
      throws_string: () => Promise.reject("boom"),
      unset_key: () => Promise.reject(new Error("ANTHROPIC_API_KEY is not set")),
      no_text_block: () => Promise.reject(new Error("recovery email generation returned no text block")),
      malformed_json: () => Promise.reject(new SyntaxError("Unexpected token")),
    };
    for (const [name, generate] of Object.entries(failures)) {
      const { result, captured } = await run({ generate });
      expect(result.sent, name).toBe(true);
      expect(result.usedTemplate, name).toBe(true);
      expect(captured.jobs, name).toHaveLength(1);
    }
  });

  // A merchant override must survive the fallback exactly as it survives
  // generation: custom_body wins over the template body too, provided it
  // carries the update link (a custom body without it is replaced, see
  // recovery-update-link-guard.test.ts).
  it("keeps a merchant custom body when falling back", async () => {
    const { clickTrackedUpdateUrl } = await buildEngagementUrls(env, ctx(), "https://foxhoundapp.com");
    const customBody = `<p>Merchant wrote this. <a href="${clickTrackedUpdateUrl}">Update</a></p>`;
    const { captured } = await run({
      context: { cached: { customBody, cachedSubject: null, cachedBodyHtml: null } },
    });
    expect(captured.jobs[0].bodyHtml).toContain("Merchant wrote this.");
  });

  // A step outside rows E4 to E6 (J85), whose own step template is Recova's
  // words in every category; email_day14 keeps the per-category copy until its
  // row's job (J86) ports Recova's.
  it("uses the category's template framing, not a generic one", async () => {
    const { captured } = await run({ context: { declineCategory: "expired", stepType: "email_day14" } });
    expect(captured.jobs[0].subject).toBe("Your card has expired");
    expect(captured.jobs[0].bodyHtml).toContain("Retrying will not help");
  });
});

describe("genuine send failures keep their backoff", () => {
  // The other half of the separation. A send failure must NOT be swallowed by the
  // fallback: there is nothing wrong with the copy, the transport failed.
  it("reschedules on a transient send failure rather than reporting sent", async () => {
    const { result, captured } = await run({
      generate: async () => ({ subject: "Quick note", bodyHtml: "<p>Update your card.</p>" }),
      send: async () => ({ status: "failed", error: "EMAIL binding unavailable" }) as EmailJobResult,
    });
    expect(result.sent).toBe(false);
    expect(captured.patches[0].patch.lastAttemptError).toBe("EMAIL binding unavailable");
    expect(captured.patches[0].patch.nextRetryAt).not.toBeNull();
    expect(captured.patches[0].patch.executedAt).toBeNull();
  });

  it("still reschedules when the send fails after a template fallback", async () => {
    const { result, captured } = await run({
      send: async () => ({ status: "failed", error: "queue unavailable" }) as EmailJobResult,
    });
    expect(result.usedTemplate).toBe(true);
    expect(result.sent).toBe(false);
    expect(captured.patches[0].patch.nextRetryAt).not.toBeNull();
  });

  it("treats a suppressed recipient as terminal success, unchanged", async () => {
    const { result } = await run({
      generate: async () => ({ subject: "Quick note", bodyHtml: "<p>Update.</p>" }),
      send: async () => ({ status: "suppressed" }) as EmailJobResult,
    });
    expect(result.sent).toBe(true);
  });

  it("reschedules when the send THROWS, which is not a generation failure", async () => {
    const { result, captured } = await run({
      generate: async () => ({ subject: "Quick note", bodyHtml: "<p>Update.</p>" }),
      send: () => Promise.reject(new Error("worker binding exploded")),
    });
    expect(result.sent).toBe(false);
    expect(captured.patches[0].patch.lastAttemptError).toBe("worker binding exploded");
  });
});

describe("cached copy is untouched by the fallback", () => {
  it("sends cached copy without generating or falling back", async () => {
    const { clickTrackedUpdateUrl } = await buildEngagementUrls(env, ctx(), "https://foxhoundapp.com");
    const { result, captured } = await run({
      generate: () => Promise.reject(new Error("must not be called")),
      context: {
        cached: {
          customBody: null,
          cachedSubject: "Cached subject",
          cachedBodyHtml: `<p>Cached body. <a href="${clickTrackedUpdateUrl}">Update</a></p>`,
        },
      },
    });
    expect(result.usedTemplate).toBe(false);
    expect(captured.jobs[0].subject).toBe("Cached subject");
    expect(captured.jobs[0].template).toBe(TEMPLATE_LABEL_GENERATED);
  });

  // The resolved copy is cached onto the step so a send-backoff retry reuses it.
  // For a fallback that means the same template goes out on retry rather than
  // hammering a failing model API again.
  it("caches the template copy so a backoff retry reuses it", async () => {
    const { captured } = await run({
      send: async () => ({ status: "failed", error: "transient" }) as EmailJobResult,
    });
    expect(captured.patches[0].cache?.subject).toBeTruthy();
    // email_day1's fallback is Recova's day 1 template (J85).
    expect(captured.patches[0].cache?.bodyHtml).toContain("temporary bank issue");
  });
});
