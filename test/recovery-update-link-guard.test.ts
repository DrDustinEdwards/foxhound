import { afterEach, describe, expect, it, vi } from "vitest";

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
import { buildTemplateEmail, hasStepTemplate } from "~/lib/recovery/email-template";
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

/** The minted click link, read from the template the executor sent. */
function clickLinkIn(html: string): string | undefined {
  return hrefs(html).find((h) => h.startsWith(`${BASE}/e/c/`));
}

/** The decoded payload of a click link (integrity is the executor's concern;
 *  this reads which step and which card page it names). */
function clickPayload(link: string): { stepId: string; kind: string; url: string } {
  return JSON.parse(
    Buffer.from(link.split("/e/c/")[1].split(".")[0], "base64url").toString(),
  ) as { stepId: string; kind: string; url: string };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("generated copy that loses the update link falls back to the template", () => {
  const LOSERS: { name: string; write: (url: string) => EmailCopy }[] = [
    {
      name: "drops the link entirely",
      write: () => ({ subject: "Quick note", bodyHtml: "<p>Please update your card.</p>" }),
    },
    {
      name: "uses legacy's placeholder instead of the link",
      write: () => ({
        subject: "Quick note",
        bodyHtml: '<p><a href="https://billing.stripe.com/p/session/[LINK]">Update</a></p>',
      }),
    },
    {
      name: "truncates the token",
      write: (url) => ({
        subject: "Quick note",
        bodyHtml: `<p><a href="${url.slice(0, -6)}">Update your card</a></p>`,
      }),
    },
    {
      name: "rewrites the host",
      write: (url) => ({
        subject: "Quick note",
        bodyHtml: `<p><a href="${url.replace(BASE, "https://example.com")}">Update</a></p>`,
      }),
    },
    {
      name: "links a made-up /p/ page instead of the minted link",
      write: () => ({
        subject: "Quick note",
        bodyHtml: `<p><a href="${BASE}/p/abc.def">Update your card</a></p>`,
      }),
    },
    {
      name: "prints the link as text but never links it",
      write: (url) => ({
        subject: "Quick note",
        bodyHtml: `<p>Update your card at ${url}</p>`,
      }),
    },
  ];

  for (const loser of LOSERS) {
    it(`${loser.name}: sends the template, carrying the minted link`, async () => {
      const { result, jobs, minted } = await run({ write: loser.write });
      expect(jobs).toHaveLength(1);
      expect(result.usedTemplate).toBe(true);
      expect(result.templateReason).toBe("missing_update_link");
      expect(jobs[0].template).toBe(TEMPLATE_LABEL_FALLBACK);
      expect(hrefs(jobs[0].bodyHtml)).toContain(minted);
      expect(result.sent).toBe(true);
    });
  }

  it("the minted link is the click-tracked wrapper of a tokenised /p/ link", async () => {
    const { minted } = await run({ write: (url) => ({ subject: "S", bodyHtml: url }) });
    expect(minted.startsWith(`${BASE}/e/c/`)).toBe(true);
    const payload = JSON.parse(
      Buffer.from(minted.split("/e/c/")[1].split(".")[0], "base64url").toString(),
    ) as { url: string; kind: string };
    expect(payload.kind).toBe("click");
    expect(payload.url.startsWith(`${BASE}/p/`)).toBe(true);
  });

  it("caches the template, not the linkless copy, for a backoff retry", async () => {
    const { patches, minted } = await run({
      write: () => ({ subject: "Quick note", bodyHtml: "<p>Please update your card.</p>" }),
    });
    expect(patches[0].cache?.bodyHtml).not.toContain("Please update your card.");
    expect(hrefs(patches[0].cache?.bodyHtml ?? "")).toContain(minted);
  });
});

describe("generated copy that carries the minted link is sent as written", () => {
  it("sends the generated body", async () => {
    const { result, jobs, minted } = await run({
      write: (url) => ({
        subject: "Quick note",
        bodyHtml: `<p>Your card did not go through. <a href="${url}">Update it here</a>.</p>`,
      }),
    });
    expect(result.usedTemplate).toBe(false);
    expect(result.templateReason).toBeNull();
    expect(jobs[0].template).toBe(TEMPLATE_LABEL_GENERATED);
    expect(jobs[0].bodyHtml).toContain("Update it here");
    expect(hrefs(jobs[0].bodyHtml)).toContain(minted);
  });

  it("accepts a single-quoted href", async () => {
    const { result } = await run({
      write: (url) => ({ subject: "Quick note", bodyHtml: `<p><a href='${url}'>Update</a></p>` }),
    });
    expect(result.usedTemplate).toBe(false);
  });
});

describe("the template always carries the link", () => {
  const CATEGORIES = ["soft", "expired", "fraud", "network", "revoked", "unknown", "something_new"];

  it("for every decline category, as an href", () => {
    const url = `${BASE}/e/c/token.sig`;
    for (const declineCategory of CATEGORIES) {
      const copy = buildTemplateEmail({
        merchantName: "Teamflow",
        declineCategory,
        amountFormatted: "$49.00",
        updateUrl: url,
      });
      expect(hrefs(copy.bodyHtml), declineCategory).toContain(url);
    }
  });

  it("through the executor, when generation throws, for every category", async () => {
    for (const declineCategory of CATEGORIES) {
      const { result, jobs, minted } = await run({ context: { declineCategory } });
      expect(result.templateReason, declineCategory).toBe("generation_failed");
      expect(hrefs(jobs[0].bodyHtml), declineCategory).toContain(minted);
    }
  });

  // Rows E4 to E8 (J85, J86): every recovery email step with Recova's own
  // template still carries the minted link when generation throws.
  it("through the executor, for every step with Recova's own template", async () => {
    for (const stepType of ["email_day1", "email_day3", "email_day7", "email_day14", "email_day30"]) {
      expect(hasStepTemplate(stepType), stepType).toBe(true);
      const { result, jobs, minted } = await run({ context: { stepType } });
      expect(result.templateReason, stepType).toBe("generation_failed");
      expect(hrefs(jobs[0].bodyHtml), stepType).toContain(minted);
      expect(jobs[0].bodyHtml, stepType).toContain(">Update Payment Method</a>");
    }
  });

  it("through the executor, when the quality gate rejects", async () => {
    const { result, jobs, minted } = await run({
      write: (url) => ({ subject: "Your day 3 reminder", bodyHtml: `<a href="${url}">x</a>` }),
    });
    expect(result.templateReason).toBe("quality_gate");
    expect(hrefs(jobs[0].bodyHtml)).toContain(minted);
  });
});

describe("a merchant custom body without the link is not sent", () => {
  it("falls back to the template on generation", async () => {
    const { result, jobs, minted } = await run({
      write: (url) => ({ subject: "Quick note", bodyHtml: `<a href="${url}">Update</a>` }),
      context: { cached: { customBody: "<p>Merchant wrote this.</p>", cachedSubject: null, cachedBodyHtml: null } },
    });
    expect(result.usedTemplate).toBe(true);
    expect(result.templateReason).toBe("missing_update_link");
    expect(jobs[0].bodyHtml).not.toContain("Merchant wrote this.");
    expect(hrefs(jobs[0].bodyHtml)).toContain(minted);
  });

  it("falls back to the bare template when generation fails too", async () => {
    const { result, jobs, minted } = await run({
      context: { cached: { customBody: "<p>Merchant wrote this.</p>", cachedSubject: null, cachedBodyHtml: null } },
    });
    expect(result.usedTemplate).toBe(true);
    expect(jobs[0].bodyHtml).not.toContain("Merchant wrote this.");
    expect(hrefs(jobs[0].bodyHtml)).toContain(minted);
  });
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

  it("replaces cached copy with no link", async () => {
    const { result, jobs } = await run({
      context: {
        cached: { customBody: null, cachedSubject: "Cached subject", cachedBodyHtml: "<p>Cached body.</p>" },
      },
    });
    expect(result.usedTemplate).toBe(true);
    expect(result.templateReason).toBe("missing_update_link");
    const link = clickLinkIn(jobs[0].bodyHtml);
    expect(link).toBeDefined();
    expect(clickPayload(link!).stepId).toBe("step_1");
    expect(clickPayload(link!).url.startsWith(`${BASE}/p/`)).toBe(true);
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

  it("replaces cached copy whose card-update link has expired", async () => {
    const stale = await earlierLink(ctx());
    // 31 days after the earlier mint: past CARD_UPDATE_TOKEN_MAX_AGE_MS (30 days).
    vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 10, 1));
    const { result, jobs } = await run({
      context: {
        cached: {
          customBody: null,
          cachedSubject: "Cached subject",
          cachedBodyHtml: `<p><a href="${stale}">Update</a></p>`,
        },
      },
    });
    expect(result.usedTemplate).toBe(true);
    const link = clickLinkIn(jobs[0].bodyHtml);
    expect(link).toBeDefined();
    expect(link).not.toBe(stale);
    expect(clickPayload(link!).stepId).toBe("step_1");
  });
});
