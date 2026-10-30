import { describe, expect, it } from "vitest";

import {
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

  // Every dunning step now has Recova's own words in every category;
  // the revoked notice is the one step Recova has no template for, so it keeps
  // the category's framing.
  it("uses the category's template framing, not a generic one", async () => {
    const { captured } = await run({ context: { declineCategory: "revoked", stepType: "email_revoked" } });
    expect(captured.jobs[0].subject).toBe("Your subscription payment was canceled");
    expect(captured.jobs[0].bodyHtml).toContain("authorization for this payment has been withdrawn");
  });
});
