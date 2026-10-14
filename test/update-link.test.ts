import { describe, expect, it, vi } from "vitest";

// The template is mocked to LOSE the link, which it never does in production,
// so the last line of defence is reached on its own: with no linked copy to
// fall back to, nothing is sent at all.
vi.mock("~/lib/recovery/email-template", () => ({
  buildTemplateEmail: () => ({ subject: "Plain", bodyHtml: "<p>No link here.</p>" }),
}));
vi.mock("~/lib/recovery/winback-email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/recovery/winback-email")>()),
  buildWinbackEmail: () => "<p>No link here.</p>",
}));

const { hrefsIn, linksTo } = await import("~/lib/recovery/update-link");
const { executeEmailStep } = await import("~/lib/engine/execute-step");
const { resolveWinbackCopy } = await import("~/lib/cron/winback");

const env = {
  BETTER_AUTH_URL: "https://foxhoundapp.com",
  PHYSICAL_ADDRESS: "1 Test St, Austin TX",
  ENCRYPTION_KEY: "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
} as unknown as Env;

describe("hrefsIn and linksTo", () => {
  const URL = "https://foxhoundapp.com/e/c/abc-_.def";

  it("reads double-quoted, single-quoted and unquoted hrefs", () => {
    const html = `<a href="${URL}">a</a><a href='b'>b</a><a HREF = c>c</a>`;
    expect(hrefsIn(html)).toEqual([URL, "b", "c"]);
  });

  it("matches the exact link only", () => {
    expect(linksTo(`<a href="${URL}">x</a>`, URL)).toBe(true);
    expect(linksTo(`<a href="${URL}x">x</a>`, URL)).toBe(false);
    expect(linksTo(`<a href="${URL.slice(0, -1)}">x</a>`, URL)).toBe(false);
    expect(linksTo(`<p>${URL}</p>`, URL)).toBe(false);
  });

  it("never matches an empty link", () => {
    expect(linksTo(`<a href="">x</a>`, "")).toBe(false);
  });
});

describe("if even the template lost the link, nothing is sent", () => {
  it("dunning: the step records a transient failure and no job is sent", async () => {
    const jobs: unknown[] = [];
    const result = await executeEmailStep(
      env,
      {
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
        cached: { customBody: null, cachedSubject: null, cachedBodyHtml: null },
      },
      {
        generate: async () => ({ subject: "Quick note", bodyHtml: "<p>No link.</p>" }),
        send: async (_e, job) => {
          jobs.push(job);
          return { status: "sent" } as never;
        },
        persistPatch: async () => {},
      },
    );
    expect(jobs).toEqual([]);
    expect(result.sent).toBe(false);
  });

  it("win-back: resolving the copy throws rather than returning linkless copy", async () => {
    await expect(
      resolveWinbackCopy(
        env,
        null as never,
        {
          stepId: "st_1",
          sequenceId: "wb_1",
          accountId: "acct_1",
          stepNumber: 1,
          customerEmail: "b@a.test",
          customerName: "Jane",
          planName: "Pro",
          amountCents: 4900,
          notificationsEnabled: null,
          senderName: "Teamflow",
          cancelReason: null,
          brandVoice: null,
          cachedSubject: null,
          cachedBodyHtml: null,
        },
        "https://foxhoundapp.com/p/tok",
      ),
    ).rejects.toThrow(/resubscribe link missing/);
  });
});
