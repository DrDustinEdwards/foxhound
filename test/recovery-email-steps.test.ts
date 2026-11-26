import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createInMemoryDb } from "./helpers/inmemory-db";

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
const { planRecoverySteps } = await import("~/lib/recovery/schedule");
const { buildTemplateEmail } = await import("~/lib/recovery/email-template");
const { hasTimingWord } = await import("~/lib/recovery/email-generation");
const { processEmailJob } = await import("~/lib/email/dispatch");
const { executeEmailStep, buildRecoveryEmailJob } = await import("~/lib/engine/execute-step");
const { queryDueRecoverySteps, toEmailContext } = await import("~/lib/cron/due-steps");

type EmailStepContext = import("~/lib/engine/execute-step").EmailStepContext;
type EmailJob = import("~/lib/email/types").EmailJob;
type EmailCopy = import("~/lib/recovery/email-generation").EmailCopy;

const BASE = "https://foxhoundapp.test";
const ADDRESS = "1 Test Way, Austin TX";
const ACCOUNT = "acct_steps";
const T0 = new Date("2026-07-01T00:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const STEPS = ["email_day1", "email_day30"] as const;

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

function ctx(over: Partial<EmailStepContext> = {}): EmailStepContext {
  return {
    stepId: "step_1",
    accountId: ACCOUNT,
    failedPaymentId: "fp_1",
    stepType: "email_day1",
    attemptCount: 0,
    declineCategory: "expired",
    liveSendsEnabled: true,
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

describe("the executor sends the step's template when generation cannot be used", () => {
  for (const stepType of STEPS) {
    it(`${stepType}: a generation failure sends the template with the amount and the update link`, async () => {
      const { result, jobs, minted } = await runStep({ stepType });
      expect(result.usedTemplate).toBe(true);
      expect(result.templateReason).toBe("generation_failed");
      expect(jobs).toHaveLength(1);
      expect(jobs[0].bodyHtml).toContain("$49.00");
      expect(jobs[0].bodyHtml).toContain(minted);
    });
  }

  it("copy that loses the update link falls back to the template", async () => {
    const { result, jobs, minted } = await runStep({ stepType: "email_day3" }, () => ({
      subject: "Card problem",
      bodyHtml: "<p>Please update your card.</p>",
    }));
    expect(result.templateReason).toBe("missing_update_link");
    expect(jobs[0].bodyHtml).toContain(minted);
  });

  it("copy with a timing word in the body falls back to the template", async () => {
    const { result, jobs } = await runStep({ stepType: "email_day14" }, (url) => ({
      subject: "Your payment still needs a fix",
      bodyHtml: `<p>We tried again this <b>morning</b>. <a href="${url}">Update it</a>.</p>`,
    }));
    expect(result.templateReason).toBe("quality_gate");
    expect(hasTimingWord(jobs[0].subject)).toBe(false);
    expect(hasTimingWord(jobs[0].bodyHtml)).toBe(false);
  });

  it("good generated copy is sent as generated, not replaced by the template", async () => {
    const { result, jobs } = await runStep({ stepType: "email_day3" }, (url) => ({
      subject: "Card trouble",
      bodyHtml: `<p>Hi Jane, the card did not work. <a href="${url}">Update it here</a>.</p>`,
    }));
    expect(result.usedTemplate).toBe(false);
    expect(jobs[0].subject).toBe("Card trouble");
  });
});

describe("a due step sends through the real dispatch", () => {
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

  async function seedPayment(customerName: string | null) {
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
      declineCategory: "expired",
      status: "active",
      detectedAt: T0,
    });
    const planned = planRecoverySteps({
      failedPaymentId: "fp_1",
      accountId: ACCOUNT,
      declineCategory: "expired",
      detectedAt: T0,
    });
    for (const [i, step] of planned.entries()) {
      await db.insert(schema.recoverySteps).values({ id: `step_${i + 1}`, ...step });
    }
  }

  it("a missing customer name greets 'there', read through the tick's own query", async () => {
    await seedPayment(null);
    const row = (await queryDueRecoverySteps(env, new Date(T0.getTime() + 720 * HOUR))).find(
      (r) => r.stepType === "email_day30",
    );
    expect(row?.customerName).toBeNull();
    await executeEmailStep(env, toEmailContext(row!), {
      generate: async () => {
        throw new Error("anthropic 503");
      },
    });
    expect(harness.sent[0].text).toContain("Hi there,");
  });

  it("a suppressed customer is refused as 'suppressed', with nothing sent", async () => {
    await seedPayment("Jane Buyer");
    const db = harness.db as ReturnType<typeof createInMemoryDb>["db"];
    await db.insert(schema.emailSuppressions).values({
      email: "jane@example.com",
      token: "tok_1",
      suppressedAt: T0,
      reason: "unsubscribe",
    });
    const job = buildRecoveryEmailJob(
      ctx(),
      buildTemplateEmail({
        stepType: "email_day1",
        declineCategory: "expired",
        merchantName: "Teamflow",
        senderName: "Teamflow",
        customerName: "Jane Buyer",
        amountFormatted: "$49.00",
        updateUrl: `${BASE}/e/c/EXAMPLE-NOT-A-TOKEN`,
      }),
      {
        unsubscribeToken: "unsub_tok",
        physicalAddress: ADDRESS,
        openUrl: `${BASE}/e/o/EXAMPLE-NOT-A-TOKEN`,
        honeypotUrl: `${BASE}/e/h/EXAMPLE-NOT-A-TOKEN`,
      },
    );
    const r = await processEmailJob(env, job, null);
    expect(r.status).toBe("suppressed");
    expect(harness.sent).toHaveLength(0);
  });

  it("customer emails off: the step is skipped, with no copy written and nothing sent", async () => {
    await seedPayment("Jane Buyer");
    const db = harness.db as ReturnType<typeof createInMemoryDb>["db"];
    await db.update(schema.accounts).set({ liveSendsEnabled: false });
    const row = (await queryDueRecoverySteps(env, new Date(T0.getTime() + 24 * HOUR))).find(
      (r) => r.stepType === "email_day1",
    );
    expect(row?.liveSendsEnabled).toBe(false);
    let generated = 0;
    const result = await executeEmailStep(env, toEmailContext(row!), {
      generate: async () => {
        generated += 1;
        throw new Error("never called");
      },
    });
    expect(result).toMatchObject({ sent: false, result: "email_skipped_sends_off" });
    expect(generated).toBe(0);
    expect(harness.sent).toHaveLength(0);
    const [stored] = await db
      .select({ result: schema.recoverySteps.result, executedAt: schema.recoverySteps.executedAt })
      .from(schema.recoverySteps)
      .where(eq(schema.recoverySteps.id, row!.stepId));
    expect(stored.result).toBe("email_skipped_sends_off");
    expect(stored.executedAt).not.toBeNull();
  });
});
