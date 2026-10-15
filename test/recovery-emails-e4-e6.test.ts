import { beforeEach, describe, expect, it, vi } from "vitest";

import { createInMemoryDb } from "./helpers/inmemory-db";

// J85, rows E4, E5 and E6 (parity/ROWS-E.md): the day 1, day 3 and day 7
// recovery emails. Recova is the spec for what each one says, carries and when
// it sends (RULES.md 1.1). The layout is Capsomer's email component (Q3), so
// nothing here asserts Recova's layout.
//
// Recova read whole, at HEAD, through Capsid repo "legacy":
//   lib/recovery-execution.ts (blob 3a8f8768): FALLBACK_TEMPLATES, lines 79 to 100
//   lib/recovery-schedules.ts (blob 88f4e97a): RECOVERY_SCHEDULES
//   lib/constants.ts (blob a21b32b8): STEP_TIMING_* hours
//   lib/email.ts (blob 3f882729): wrapEmailHtml, the footer sentence
//
// Left to their own jobs and NOT asserted here: Reply-To (J03) and the timing
// word gate (J01). The update-link check (J04) and the shell (J02) are merged
// and are extended to these three emails below.

interface SentMessage {
  from: string;
  to: string;
  subject: string;
  html: string;
  text?: string;
  headers?: Record<string, string>;
}

const harness = vi.hoisted(() => ({
  db: null as unknown,
  sent: [] as SentMessage[],
}));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const schema = await import("~/db/schema");
const constants = await import("~/lib/constants");
const { RECOVERY_SCHEDULES, planRecoverySteps } = await import("~/lib/recovery/schedule");
const { buildTemplateEmail } = await import("~/lib/recovery/email-template");
const { passesQualityGate } = await import("~/lib/recovery/email-generation");
const { linksTo } = await import("~/lib/recovery/update-link");
const { htmlToBlocks } = await import("~/lib/email/templates");
const { buildEmailMessage } = await import("~/lib/email/send");
const { processEmailJob } = await import("~/lib/email/dispatch");
const { executeEmailStep, buildRecoveryEmailJob } = await import("~/lib/engine/execute-step");
const { queryDueRecoverySteps, toEmailContext } = await import("~/lib/cron/recovery-tick");

type EmailStepContext = import("~/lib/engine/execute-step").EmailStepContext;
type EmailJob = import("~/lib/email/types").EmailJob;
type EmailCopy = import("~/lib/recovery/email-generation").EmailCopy;

const BASE = "https://foxhoundapp.test";
const ADDRESS = "1 Test Way, Austin TX";
const ACCOUNT = "acct_e4";
const URL = `${BASE}/e/c/EXAMPLE-NOT-A-TOKEN`;
const HOUR = 60 * 60 * 1000;

const env = {
  ENCRYPTION_KEY: "ab".repeat(32),
  BETTER_AUTH_URL: BASE,
  PHYSICAL_ADDRESS: ADDRESS,
  EMAIL: {
    send: async (m: SentMessage) => {
      harness.sent.push(m);
      return { id: "msg_1" };
    },
  },
} as unknown as Env;

// ---- Recova's words, step by step ---------------------------------------------
//
// FALLBACK_TEMPLATES in lib/recovery-execution.ts, with applyTemplate's
// variables: customer_name is `fp.customer_name || 'there'`, sender_name is
// `merchant.sender_name || 'Support'`, amount is the formatted amount, and
// update_url is the button. The inline CTA style is Recova's amber layout and
// gives way to Capsomer's button (Q3); the words are kept exactly.

type Block = ReturnType<typeof htmlToBlocks>[number];

interface RecovaStep {
  subject: string;
  blocks: (v: { name: string; amount: string; url: string; sender: string }) => Block[];
}

const RECOVA: Record<"email_day1" | "email_day3" | "email_day7", RecovaStep> = {
  email_day1: {
    subject: "Your payment didn't go through",
    blocks: ({ name, amount, url, sender }) => [
      { type: "paragraph", text: `Hi ${name},` },
      {
        type: "paragraph",
        text: `Your recent payment of ${amount} didn't process. This usually happens with an expired card or a temporary bank issue.`,
      },
      { type: "paragraph", text: "You can update your payment method here:" },
      { type: "button", label: "Update Payment Method", url },
      { type: "paragraph", text: sender },
    ],
  },
  email_day3: {
    subject: "Still having trouble with your payment",
    blocks: ({ name, amount, url, sender }) => [
      { type: "paragraph", text: `Hi ${name},` },
      {
        type: "paragraph",
        text: `We still haven't been able to process your payment of ${amount}. Your account will be suspended soon if this isn't resolved.`,
      },
      { type: "button", label: "Update Payment Method", url },
      { type: "paragraph", text: sender },
    ],
  },
  email_day7: {
    subject: "Account access at risk",
    blocks: ({ name, amount, url, sender }) => [
      { type: "paragraph", text: `Hi ${name},` },
      {
        type: "paragraph",
        text: `It has been a week since your payment of ${amount} failed. Update your payment method now to keep your access.`,
      },
      { type: "button", label: "Update Payment Method", url },
      { type: "paragraph", text: sender },
    ],
  },
};

const STEPS = Object.keys(RECOVA) as (keyof typeof RECOVA)[];
// Every category that schedules one of these steps. Recova's fallback is per
// step, never per category, so all of them get the same words.
const CATEGORIES = ["soft", "network", "expired", "fraud", "unknown"] as const;

// ---- 1. When each email sends ---------------------------------------------------

function offsetOf(category: keyof typeof RECOVERY_SCHEDULES, stepType: string): number | undefined {
  return RECOVERY_SCHEDULES[category].find((s) => s.stepType === stepType)?.offsetHours;
}

describe("E4 to E6 send on Recova's timing (lib/recovery-schedules.ts, lib/constants.ts)", () => {
  it("day 1 is Recova's 1 hour for an expired card, and for unknown, which runs expired's cadence", () => {
    expect(constants.STEP_TIMING_EMAIL_DAY1_HOURS).toBe(1);
    expect(offsetOf("expired", "email_day1")).toBe(1);
    expect(offsetOf("unknown", "email_day1")).toBe(1);
  });

  it("day 1 is Recova's 2 hours for fraud", () => {
    expect(offsetOf("fraud", "email_day1")).toBe(2);
  });

  it("day 1 for a soft decline still follows the silent retry (APPROVED-DIFFERENCES, 2026-08-01)", () => {
    const retry = offsetOf("soft", "retry_early");
    const day1 = offsetOf("soft", "email_day1");
    expect(retry).toBeDefined();
    expect(day1).toBeDefined();
    expect(day1!).toBeGreaterThan(retry!);
  });

  it("a network decline has no day 1 email, as in Recova", () => {
    expect(offsetOf("network", "email_day1")).toBeUndefined();
  });

  it("day 3 is Recova's 48 hours for network, after Recova's network retry at 24 hours", () => {
    expect(offsetOf("network", "email_day3")).toBe(48);
    expect(offsetOf("network", "retry_day2")).toBe(24);
  });

  it("day 3 is 72 hours and day 7 is 168 hours for every other category", () => {
    for (const c of ["soft", "expired", "fraud", "unknown"] as const) {
      expect(offsetOf(c, "email_day3")).toBe(72);
    }
    for (const c of CATEGORIES) {
      expect(offsetOf(c, "email_day7")).toBe(168);
    }
  });

  it("revoked sends none of these three", () => {
    for (const s of STEPS) expect(offsetOf("revoked", s)).toBeUndefined();
  });
});

// ---- 2. What each email says ----------------------------------------------------

describe("E4 to E6 fallback copy is Recova's FALLBACK_TEMPLATES, step by step", () => {
  for (const stepType of STEPS) {
    for (const declineCategory of CATEGORIES) {
      it(`${stepType} (${declineCategory}): subject and every sentence are Recova's`, () => {
        const copy = buildTemplateEmail({
          stepType,
          declineCategory,
          merchantName: "Teamflow",
          senderName: "Teamflow",
          customerName: "Jane Buyer",
          amountFormatted: "$49.00",
          updateUrl: URL,
        });
        expect(copy.subject).toBe(RECOVA[stepType].subject);
        expect(htmlToBlocks(copy.bodyHtml)).toEqual(
          RECOVA[stepType].blocks({ name: "Jane Buyer", amount: "$49.00", url: URL, sender: "Teamflow" }),
        );
      });
    }

    it(`${stepType}: Recova's own fallbacks, "there" and "Support", when the names are missing`, () => {
      const copy = buildTemplateEmail({
        stepType,
        declineCategory: "soft",
        merchantName: "your subscription",
        senderName: null,
        customerName: null,
        amountFormatted: "$49.00",
        updateUrl: URL,
      });
      expect(htmlToBlocks(copy.bodyHtml)).toEqual(
        RECOVA[stepType].blocks({ name: "there", amount: "$49.00", url: URL, sender: "Support" }),
      );
    });

    it(`${stepType}: names are text, never markup`, () => {
      const copy = buildTemplateEmail({
        stepType,
        declineCategory: "soft",
        merchantName: "A<b>",
        senderName: "A & B <Co>",
        customerName: '<img src=x onerror="y">Jo',
        amountFormatted: "$49.00",
        updateUrl: URL,
      });
      expect(copy.bodyHtml).not.toContain("<img");
      expect(copy.bodyHtml).not.toContain("<Co>");
      const blocks = htmlToBlocks(copy.bodyHtml);
      expect(blocks[0]).toEqual({ type: "paragraph", text: 'Hi <img src=x onerror="y">Jo,' });
      expect(blocks.at(-1)).toEqual({ type: "paragraph", text: "A & B <Co>" });
    });

    it(`${stepType}: passes the quality gate (RULES.md 3.15) and links the update URL (J04)`, () => {
      for (const declineCategory of CATEGORIES) {
        const copy = buildTemplateEmail({
          stepType,
          declineCategory,
          merchantName: "Teamflow",
          senderName: "Teamflow",
          customerName: "Jane Buyer",
          amountFormatted: "$49.00",
          updateUrl: URL,
        });
        expect(passesQualityGate(copy)).toBe(true);
        expect(linksTo(copy.bodyHtml, URL)).toBe(true);
      }
    });
  }

  it("a step outside E4 to E6 keeps the per-category template (E7 and E8 are J86's)", () => {
    const input = {
      declineCategory: "expired",
      merchantName: "Teamflow",
      amountFormatted: "$49.00",
      updateUrl: URL,
    };
    const perCategory = buildTemplateEmail(input);
    for (const stepType of ["email_day14", "email_day30", "email_revoked"]) {
      expect(buildTemplateEmail({ ...input, stepType })).toEqual(perCategory);
    }
  });
});

// ---- 3. The executor sends Recova's words when generation fails ----------------

function ctx(over: Partial<EmailStepContext> = {}): EmailStepContext {
  return {
    stepId: "step_1",
    accountId: ACCOUNT,
    failedPaymentId: "fp_1",
    stepType: "email_day1",
    attemptCount: 0,
    declineCategory: "expired",
    customerEmail: "jane@example.com",
    customerName: "Jane Buyer",
    amountCents: 4900,
    currency: "usd",
    merchantName: "Teamflow",
    senderName: "Teamflow",
    voiceDescription: null,
    cached: { customBody: null, cachedSubject: null, cachedBodyHtml: null },
    ...over,
  };
}

async function runStep(over: Partial<EmailStepContext>, write?: (url: string) => EmailCopy) {
  const jobs: EmailJob[] = [];
  let minted = "";
  const result = await executeEmailStep(env, ctx(over), {
    generate: async (_e, updateUrl) => {
      minted = updateUrl;
      if (!write) throw new Error("anthropic 503");
      return write(updateUrl);
    },
    send: async (_e, job) => {
      jobs.push(job);
      return { status: "sent", providerMessageId: "m", error: null, retryable: false };
    },
    persistPatch: async () => {},
  });
  return { result, jobs, minted };
}

describe("E4 to E6: the executor sends Recova's step template when generation cannot be used", () => {
  for (const stepType of STEPS) {
    it(`${stepType}: a generation failure sends Recova's ${stepType} words`, async () => {
      const { result, jobs, minted } = await runStep({ stepType });
      expect(result.usedTemplate).toBe(true);
      expect(result.templateReason).toBe("generation_failed");
      expect(jobs).toHaveLength(1);
      expect(jobs[0].subject).toBe(RECOVA[stepType].subject);
      expect(htmlToBlocks(jobs[0].bodyHtml)).toEqual(
        RECOVA[stepType].blocks({ name: "Jane Buyer", amount: "$49.00", url: minted, sender: "Teamflow" }),
      );
    });

    it(`${stepType}: copy that loses the update link falls back to Recova's ${stepType} words (J04)`, async () => {
      const { result, jobs, minted } = await runStep({ stepType }, () => ({
        subject: "Card problem",
        bodyHtml: "<p>Please update your card.</p>",
      }));
      expect(result.templateReason).toBe("missing_update_link");
      expect(jobs[0].subject).toBe(RECOVA[stepType].subject);
      expect(htmlToBlocks(jobs[0].bodyHtml)).toEqual(
        RECOVA[stepType].blocks({ name: "Jane Buyer", amount: "$49.00", url: minted, sender: "Teamflow" }),
      );
    });

    it(`${stepType}: copy that fails the quality gate falls back to Recova's ${stepType} words`, async () => {
      const { result, jobs } = await runStep({ stepType }, (url) => ({
        subject: "Card problem \u2014 fix it",
        bodyHtml: `<p><a href="${url}">Fix</a></p>`,
      }));
      expect(result.templateReason).toBe("quality_gate");
      expect(jobs[0].subject).toBe(RECOVA[stepType].subject);
    });
  }

  it("good generated copy is sent as generated, not replaced by the template", async () => {
    const { result, jobs } = await runStep({ stepType: "email_day3" }, (url) => ({
      subject: "Card trouble",
      bodyHtml: `<p>Hi Jane, the card did not work. <a href="${url}">Update it here</a>.</p>`,
    }));
    expect(result.usedTemplate).toBe(false);
    expect(jobs[0].subject).toBe("Card trouble");
  });
});

// ---- 4. What each email carries -------------------------------------------------

describe("E4 to E6 carry Recova's From, recipient, parts, footer and links", () => {
  for (const stepType of STEPS) {
    it(`${stepType}: From the merchant's sender name, to the customer, both parts, the footer and the tracked button`, async () => {
      const { jobs, minted } = await runStep({ stepType });
      const job = jobs[0];
      const m = buildEmailMessage(job, BASE);
      const year = new Date().getUTCFullYear();

      // From and recipient (Recova: `${sender_name || 'Support'} <recovery@...>`,
      // to fp.customer_email). Reply-To is J03's and is not asserted here.
      expect(m.from).toBe(`Teamflow <${constants.EMAIL_FROM_ADDRESS}>`);
      expect(m.to).toBe("jane@example.com");
      expect(m.subject).toBe(RECOVA[stepType].subject);

      // Both parts carry every sentence of Recova's body.
      const words = RECOVA[stepType]
        .blocks({ name: "Jane Buyer", amount: "$49.00", url: minted, sender: "Teamflow" })
        .map((b) => (b.type === "button" ? b.label : (b as { text: string }).text));
      for (const w of words) expect(m.text).toContain(w);

      // The button is Foxhound's click-tracked link to /p/:token (rows F8, F10),
      // in the HTML part as a real link with visible text.
      expect(minted.startsWith(`${BASE}${constants.ENGAGEMENT_CLICK_PATH}/`)).toBe(true);
      expect(m.html).toContain(`href="${minted}"`);
      expect(m.html).toContain("Update Payment Method");

      // Recova's footer sentence (lib/email.ts wrapEmailHtml), then the
      // unsubscribe link and the postal address, in both parts.
      const note = `You're receiving this from Teamflow about a recent payment. © ${year}`;
      expect(job.footerNote).toBe(note);
      expect(m.text).toContain(note);
      for (const part of [m.html, m.text ?? ""]) {
        expect(part).toContain("Unsubscribe");
        expect(part).toContain(ADDRESS);
      }
      expect(m.headers?.["List-Unsubscribe"]).toMatch(/^<https:\/\/foxhoundapp\.test\/u\//);
      expect(m.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");

      // First-party open pixel and honeypot, HTML part only.
      expect(m.html).toContain(`${BASE}${constants.ENGAGEMENT_OPEN_PATH}/`);
      expect(m.html).toContain(`${BASE}${constants.ENGAGEMENT_HONEYPOT_PATH}/`);
      expect(m.text).not.toContain(constants.ENGAGEMENT_OPEN_PATH + "/");
      expect(m.text).not.toContain(constants.ENGAGEMENT_HONEYPOT_PATH + "/");
    });
  }

  it("the footer sentence names Recova's 'Support' when the merchant set no sender name", async () => {
    const { jobs } = await runStep({ senderName: null, merchantName: "your subscription" });
    expect(jobs[0].footerNote).toMatch(/^You're receiving this from Support about a recent payment\. © \d{4}$/);
    expect(buildEmailMessage(jobs[0], BASE).from).toBe(`Support <${constants.EMAIL_FROM_ADDRESS}>`);
  });

  it("merchant notices never carry the footer sentence (RULES.md 3.16)", () => {
    const job = {
      ...buildRecoveryEmailJob(ctx(), { subject: "S", bodyHtml: "<p>B</p>" }, {
        unsubscribeToken: "u",
        physicalAddress: ADDRESS,
        openUrl: `${BASE}/e/o/x`,
        honeypotUrl: `${BASE}/e/h/x`,
      }),
      audience: "merchant" as const,
      tracking: null,
    };
    const m = buildEmailMessage(job, BASE);
    expect(m.text).not.toContain("You're receiving this from");
    expect(m.html).not.toContain("You're receiving this from");
  });
});

// ---- 5. End to end: the trigger, the timing and the recipient ------------------

describe("E4 to E6 end to end: a due step sends to the customer at Recova's offset and not before", () => {
  const T0 = new Date("2026-07-01T00:00:00.000Z");

  beforeEach(async () => {
    const { db } = createInMemoryDb();
    harness.db = db;
    harness.sent = [];
    await db.insert(schema.accounts).values({
      id: ACCOUNT,
      name: "Teamflow Inc",
      createdAt: T0,
      liveSendsEnabled: true,
    });
    await db.insert(schema.stripeConnections).values({
      id: "conn_1",
      accountId: ACCOUNT,
      stripeUserId: "acct_connected_1",
      stripeAccessToken: "iv:cipher",
      isPrimary: true,
      senderName: "Teamflow",
      createdAt: T0,
    });
  });

  async function seedPayment(category: "expired" | "network" | "fraud" | "soft", customerName: string | null) {
    const db = harness.db as ReturnType<typeof createInMemoryDb>["db"];
    await db.insert(schema.failedPayments).values({
      id: "fp_1",
      accountId: ACCOUNT,
      stripeConnectionId: "conn_1",
      stripeEventId: "evt_1",
      stripeInvoiceId: "in_1",
      stripeCustomerId: "cus_1",
      customerEmail: "jane@example.com",
      customerName,
      amountCents: 4900,
      currency: "usd",
      declineCategory: category,
      status: "active",
      detectedAt: T0,
    });
    const planned = planRecoverySteps({
      failedPaymentId: "fp_1",
      accountId: ACCOUNT,
      declineCategory: category,
      detectedAt: T0,
    });
    for (const [i, step] of planned.entries()) {
      await db.insert(schema.recoverySteps).values({ id: `step_${i + 1}`, ...step });
    }
    return planned;
  }

  const at = (hours: number) => new Date(T0.getTime() + hours * HOUR);

  const cases = [
    { category: "expired", stepType: "email_day1", hours: 1 },
    { category: "fraud", stepType: "email_day1", hours: 2 },
    { category: "network", stepType: "email_day3", hours: 48 },
    { category: "expired", stepType: "email_day3", hours: 72 },
    { category: "expired", stepType: "email_day7", hours: 168 },
  ] as const;

  for (const c of cases) {
    it(`${c.category} ${c.stepType}: not due a minute before ${c.hours}h, due at ${c.hours}h, sent to the customer`, async () => {
      await seedPayment(c.category, "Jane Buyer");
      const dueBefore = (await queryDueRecoverySteps(env, new Date(at(c.hours).getTime() - 60_000))).map(
        (r) => r.stepType,
      );
      expect(dueBefore).not.toContain(c.stepType);

      const due = await queryDueRecoverySteps(env, at(c.hours));
      const row = due.find((r) => r.stepType === c.stepType);
      expect(row).toBeDefined();
      const context = toEmailContext(row!);
      expect(context.customerName).toBe("Jane Buyer");

      const result = await executeEmailStep(env, context, {
        generate: async () => {
          throw new Error("anthropic 503");
        },
      });
      expect(result.sent).toBe(true);
      expect(harness.sent).toHaveLength(1);
      const m = harness.sent[0];
      expect(m.to).toBe("jane@example.com");
      expect(m.from).toBe(`Teamflow <${constants.EMAIL_FROM_ADDRESS}>`);
      expect(m.subject).toBe(RECOVA[c.stepType].subject);
      expect(m.text).toContain("Hi Jane Buyer,");
    });
  }

  it("a missing customer name greets 'there', read through the tick's own query", async () => {
    await seedPayment("expired", null);
    const row = (await queryDueRecoverySteps(env, at(1))).find((r) => r.stepType === "email_day1");
    expect(row?.customerName).toBeNull();
    await executeEmailStep(env, toEmailContext(row!), {
      generate: async () => {
        throw new Error("anthropic 503");
      },
    });
    expect(harness.sent[0].text).toContain("Hi there,");
  });

  // ---- a refused send returns its named outcome (RULES.md 3.16) ----

  function e4Job(over: Partial<EmailJob> = {}): EmailJob {
    return {
      ...buildRecoveryEmailJob(
        ctx({ stepId: "step_1", failedPaymentId: "fp_1" }),
        buildTemplateEmail({
          stepType: "email_day1",
          declineCategory: "expired",
          merchantName: "Teamflow",
          senderName: "Teamflow",
          customerName: "Jane Buyer",
          amountFormatted: "$49.00",
          updateUrl: URL,
        }),
        {
          unsubscribeToken: "unsub_tok",
          physicalAddress: ADDRESS,
          openUrl: `${BASE}/e/o/EXAMPLE-NOT-A-TOKEN`,
          honeypotUrl: `${BASE}/e/h/EXAMPLE-NOT-A-TOKEN`,
        },
      ),
      ...over,
    };
  }

  it("a suppressed customer is refused as 'suppressed', with nothing sent", async () => {
    await seedPayment("expired", "Jane Buyer");
    const db = harness.db as ReturnType<typeof createInMemoryDb>["db"];
    await db.insert(schema.emailSuppressions).values({
      email: "jane@example.com",
      token: "tok_1",
      suppressedAt: T0,
      reason: "unsubscribe",
    });
    const r = await processEmailJob(env, e4Job(), null);
    expect(r.status).toBe("suppressed");
    expect(harness.sent).toHaveLength(0);
  });

  it("an account not switched on is refused as 'blocked', with nothing sent", async () => {
    await seedPayment("expired", "Jane Buyer");
    const db = harness.db as ReturnType<typeof createInMemoryDb>["db"];
    await db.update(schema.accounts).set({ liveSendsEnabled: false });
    const r = await processEmailJob(env, e4Job(), null);
    expect(r.status).toBe("blocked");
    expect(r.error).toBeTruthy();
    expect(harness.sent).toHaveLength(0);
  });

  it("a send with no postal address is refused as 'failed', naming CAN-SPAM, with nothing sent", async () => {
    await seedPayment("expired", "Jane Buyer");
    const r = await processEmailJob(env, e4Job({ physicalAddress: "" }), null);
    expect(r.status).toBe("failed");
    expect(r.error).toContain("CAN-SPAM");
    expect(harness.sent).toHaveLength(0);
  });
});
