import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildEngagementUrls,
  executeEmailStep,
  type EmailStepContext,
} from "~/lib/engine/execute-step";
import type { EmailJob } from "~/lib/email/types";
import type { EmailJobResult } from "~/lib/email/dispatch";
import type { EmailCopy } from "~/lib/recovery/email-generation";
import type { StepStatePatch } from "~/lib/recovery/step-state";

// No recovery email leaves without its update link (RULES.md 3.15: if the
// generated copy cannot be used, send the template). A body that drops or
// rewrites the click-tracked card-update link loses the recovery AND the
// billable click, so the executor checks the body after generation and before
// the send, and falls back to the template, which always carries the link.

const BASE = "https://foxhoundapp.com";
const env = {
  BETTER_AUTH_URL: BASE,
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

/** Drive the executor. `write` builds the generated copy from the link the
 *  executor minted, so a test can include it, drop it, or rewrite it. */
async function run(opts: {
  write?: (mintedUrl: string) => EmailCopy;
  context?: Partial<EmailStepContext>;
}) {
  const jobs: EmailJob[] = [];
  const patches: { patch: StepStatePatch; cache?: EmailCopy }[] = [];
  let minted = "";
  const result = await executeEmailStep(env, ctx(opts.context), {
    generate: async (_e, updateUrl) => {
      minted = updateUrl;
      if (!opts.write) throw new Error("anthropic 503");
      return opts.write(updateUrl);
    },
    send: (_e, job) => {
      jobs.push(job);
      return Promise.resolve({ status: "sent" } as EmailJobResult);
    },
    persistPatch: async (_e, _id, patch, cache) => {
      patches.push({ patch, cache });
    },
  });
  return { result, jobs, patches, minted };
}

/** The href values of a body, so a test reads links, not loose substrings. */
function hrefs(html: string): string[] {
  return [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
}



afterEach(() => {
  vi.restoreAllMocks();
});

describe("cached copy is checked too", () => {
  /** A click link minted for `c` at an EARLIER moment, as a prior attempt would
   *  have minted it, so it differs from this attempt's link. */
  async function earlierLink(c: EmailStepContext): Promise<string> {
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 9, 1));
    const urls = await buildEngagementUrls(env, c, BASE);
    // This attempt runs four days later unless a test moves the clock again.
    clock.mockReturnValue(Date.UTC(2026, 9, 5));
    return urls.clickTrackedUpdateUrl;
  }

  it("sends cached copy carrying the link an earlier attempt minted for this step", async () => {
    const earlier = await earlierLink(ctx());
    // What THIS attempt mints is a different string, so only the verified path
    // can accept the stored link.
    const fresh = (await buildEngagementUrls(env, ctx(), BASE)).clickTrackedUpdateUrl;
    const { result, jobs } = await run({
      context: {
        attemptCount: 1,
        cached: {
          customBody: null,
          cachedSubject: "Cached subject",
          cachedBodyHtml: `<p>Cached body. <a href="${earlier}">Update</a></p>`,
        },
      },
    });
    expect(earlier).not.toBe(fresh);
    expect(result.usedTemplate).toBe(false);
    expect(jobs[0].subject).toBe("Cached subject");
    expect(hrefs(jobs[0].bodyHtml)).toContain(earlier);
  });

  it("replaces cached copy whose link belongs to another step", async () => {
    const other = await earlierLink(ctx({ stepId: "step_other" }));
    const { result, jobs } = await run({
      context: {
        cached: {
          customBody: null,
          cachedSubject: "Cached subject",
          cachedBodyHtml: `<p><a href="${other}">Update</a></p>`,
        },
      },
    });
    expect(result.usedTemplate).toBe(true);
    expect(hrefs(jobs[0].bodyHtml)).not.toContain(other);
  });

  it("replaces cached copy whose link opens another payment's card page", async () => {
    const other = await earlierLink(ctx({ failedPaymentId: "fp_other" }));
    const { result } = await run({
      context: {
        cached: {
          customBody: null,
          cachedSubject: "Cached subject",
          cachedBodyHtml: `<p><a href="${other}">Update</a></p>`,
        },
      },
    });
    expect(result.usedTemplate).toBe(true);
  });
});
