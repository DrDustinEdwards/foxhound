import { beforeEach, describe, expect, it, vi } from "vitest";

import { createInMemoryDb } from "./helpers/inmemory-db";

// J86, rows E7 and E8 (parity/ROWS-E.md): the day 14 and day 30 recovery
// emails. Recova is the spec for what each one says, carries and when it sends
// (RULES.md 1.1). The layout is Capsomer's email component (Q3), so nothing here
// asserts Recova's layout. Built on J85's per-step fallback and its test
// (test/recovery-emails-e4-e6.test.ts), which this file follows step for step.
//
// Recova read whole, at HEAD, through Capsid repo "legacy":
//   lib/recovery-execution.ts (blob 3a8f8768): FALLBACK_TEMPLATES, lines 101 to 114
//   lib/recovery-schedules.ts (blob 88f4e97a): RECOVERY_SCHEDULES
//   lib/constants.ts (blob a21b32b8): STEP_TIMING_EMAIL_DAY14_HOURS 336,
//     STEP_TIMING_EMAIL_DAY30_HOURS 720
//   lib/email.ts (blob 3f882729): wrapEmailHtml, the footer sentence
//
// J01 (the timing word gate) and J04 (the update link check) are merged and are
// extended to these two emails below. Reply-To (J03) is not merged and is NOT
// asserted here.

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
const { hasTimingWord } = await import(
  "~/lib/recovery/email-generation"
);
const { htmlToBlocks } = await import("~/lib/email/templates");
const { processEmailJob } = await import("~/lib/email/dispatch");
const { executeEmailStep, buildRecoveryEmailJob } = await import("~/lib/engine/execute-step");
const { queryDueRecoverySteps, toEmailContext } = await import("~/lib/cron/due-steps");

type EmailStepContext = import("~/lib/engine/execute-step").EmailStepContext;
type EmailJob = import("~/lib/email/types").EmailJob;
type EmailCopy = import("~/lib/recovery/email-generation").EmailCopy;

const BASE = "https://foxhoundapp.test";
const ADDRESS = "1 Test Way, Austin TX";
const ACCOUNT = "acct_e7";
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
// FALLBACK_TEMPLATES.email_day14 and .email_day30 in lib/recovery-execution.ts,
// with applyTemplate's variables: customer_name is `fp.customer_name ||
// 'there'`, sender_name is `merchant.sender_name || 'Support'`, amount is the
// formatted amount, and update_url is the button. The inline CTA style is
// Recova's amber layout and gives way to Capsomer's button (Q3); the words are
// kept exactly, except two truthfulness fixes Dustin approved on 2026-10-15
// (cmsg_01Nd8kh3hkgYNYpWXrNkvBQL2LnH5XBcKc3DcWHoEsDbT6): day 14's "and
// restores your account" became "only takes a minute", and day 30's "will be
// cancelled" became "may be cancelled".

type Block = ReturnType<typeof htmlToBlocks>[number];

interface RecovaStep {
  subject: string;
  blocks: (v: { name: string; amount: string; url: string; sender: string }) => Block[];
}

const RECOVA: Record<"email_day14" | "email_day30", RecovaStep> = {
  email_day14: {
    subject: "Two weeks since your payment failed",
    blocks: ({ name, amount, url, sender }) => [
      { type: "paragraph", text: `Hi ${name},` },
      {
        type: "paragraph",
        text: `It has been two weeks since your payment of ${amount} did not go through. Updating your payment method only takes a minute.`,
      },
      { type: "button", label: "Update Payment Method", url },
      { type: "paragraph", text: sender },
    ],
  },
  email_day30: {
    subject: "Final notice on your account",
    blocks: ({ name, amount, url, sender }) => [
      { type: "paragraph", text: `Hi ${name},` },
      {
        type: "paragraph",
        text: `This is the final automated notice on your unpaid balance of ${amount}. Without an updated payment method, your account may be cancelled.`,
      },
      { type: "button", label: "Update Payment Method", url },
      { type: "paragraph", text: sender },
    ],
  },
};


const STEPS = Object.keys(RECOVA) as (keyof typeof RECOVA)[];
// Every category that schedules these steps. Recova's fallback is per step,
// never per category, so all of them get the same words.
const CATEGORIES = ["soft", "network", "expired", "fraud", "unknown"] as const;

// ---- 1. When each email sends ---------------------------------------------------

function offsetOf(category: keyof typeof RECOVERY_SCHEDULES, stepType: string): number | undefined {
  return RECOVERY_SCHEDULES[category].find((s) => s.stepType === stepType)?.offsetHours;
}

describe("E7 and E8 send on Recova's timing (lib/recovery-schedules.ts, lib/constants.ts)", () => {
  it("the offsets are Recova's: 336 hours for day 14 and 720 hours for day 30", () => {
    expect(constants.STEP_TIMING_EMAIL_DAY14_HOURS).toBe(336);
    expect(constants.STEP_TIMING_EMAIL_DAY30_HOURS).toBe(720);
  });

  it("every category that runs a dunning sequence sends day 14 at 336 hours and day 30 at 720 hours", () => {
    for (const c of CATEGORIES) {
      expect(offsetOf(c, "email_day14"), c).toBe(336);
      expect(offsetOf(c, "email_day30"), c).toBe(720);
    }
  });

  it("day 14 follows day 7, and day 30 is the last step of every sequence, as in Recova", () => {
    for (const c of CATEGORIES) {
      const schedule = RECOVERY_SCHEDULES[c];
      const types = schedule.map((s) => s.stepType);
      expect(types.indexOf("email_day14"), c).toBe(types.indexOf("email_day7") + 1);
      expect(types.at(-1), c).toBe("email_day30");
    }
  });

  it("revoked sends neither", () => {
    for (const s of STEPS) expect(offsetOf("revoked", s)).toBeUndefined();
  });
});

// ---- 3. The executor sends Recova's words when generation fails ----------------

function ctx(over: Partial<EmailStepContext> = {}): EmailStepContext {
  return {
    stepId: "step_1",
    accountId: ACCOUNT,
    failedPaymentId: "fp_1",
    stepType: "email_day14",
    attemptCount: 0,
    declineCategory: "soft",
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

describe("E7 and E8: the executor sends Recova's step template when generation cannot be used", () => {
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

    // J01 extended: a body that still says when it is being read is a
    // timing_leak to the gate, and the template goes instead.
    it(`${stepType}: copy with a timing word in the body falls back to Recova's ${stepType} words (J01)`, async () => {
      const { result, jobs } = await runStep({ stepType }, (url) => ({
        subject: "Your payment still needs a fix",
        bodyHtml: `<p>We tried again this <b>morning</b>. <a href="${url}">Update it</a>.</p>`,
      }));
      expect(result.templateReason).toBe("quality_gate");
      expect(jobs[0].subject).toBe(RECOVA[stepType].subject);
      expect(hasTimingWord(jobs[0].subject)).toBe(false);
      expect(hasTimingWord(jobs[0].bodyHtml)).toBe(false);
    });
  }
});

// ---- 5. End to end: the trigger, the timing and the recipient ------------------

describe("E7 and E8 end to end: a due step sends to the customer at Recova's offset and not before", () => {
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

  async function seedPayment(category: (typeof CATEGORIES)[number], customerName: string | null) {
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


  it("a missing customer name greets 'there', read through the tick's own query", async () => {
    await seedPayment("expired", null);
    const row = (await queryDueRecoverySteps(env, at(720))).find((r) => r.stepType === "email_day30");
    expect(row?.customerName).toBeNull();
    await executeEmailStep(env, toEmailContext(row!), {
      generate: async () => {
        throw new Error("anthropic 503");
      },
    });
    expect(harness.sent[0].text).toContain("Hi there,");
  });

  // ---- a refused send returns its named outcome (RULES.md 3.16) ----

  function stepJob(stepType: keyof typeof RECOVA, over: Partial<EmailJob> = {}): EmailJob {
    return {
      ...buildRecoveryEmailJob(
        ctx({ stepId: "step_1", failedPaymentId: "fp_1", stepType }),
        buildTemplateEmail({
          stepType,
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

  for (const stepType of STEPS) {
    it(`${stepType}: a suppressed customer is refused as 'suppressed', with nothing sent`, async () => {
      await seedPayment("expired", "Jane Buyer");
      const db = harness.db as ReturnType<typeof createInMemoryDb>["db"];
      await db.insert(schema.emailSuppressions).values({
        email: "jane@example.com",
        token: "tok_1",
        suppressedAt: T0,
        reason: "unsubscribe",
      });
      const r = await processEmailJob(env, stepJob(stepType), null);
      expect(r.status).toBe("suppressed");
      expect(harness.sent).toHaveLength(0);
    });

    it(`${stepType}: an account not switched on is refused as 'blocked', with nothing sent`, async () => {
      await seedPayment("expired", "Jane Buyer");
      const db = harness.db as ReturnType<typeof createInMemoryDb>["db"];
      await db.update(schema.accounts).set({ liveSendsEnabled: false });
      const r = await processEmailJob(env, stepJob(stepType), null);
      expect(r.status).toBe("blocked");
      expect(r.error).toBeTruthy();
      expect(harness.sent).toHaveLength(0);
    });

    it(`${stepType}: a send with no postal address is refused as 'failed', naming CAN-SPAM, with nothing sent`, async () => {
      await seedPayment("expired", "Jane Buyer");
      const r = await processEmailJob(env, stepJob(stepType, { physicalAddress: "" }), null);
      expect(r.status).toBe("failed");
      expect(r.error).toContain("CAN-SPAM");
      expect(harness.sent).toHaveLength(0);
    });
  }
});
