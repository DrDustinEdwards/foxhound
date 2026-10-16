import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createInMemoryDb } from "./helpers/inmemory-db";

// J06 (job_4f4c9c2f5383): the dispute deadline reminder. Recova's spec is
// app/api/cron/process-disputes/route.ts (blob 1cbd5bd0), "Thing 1": an open,
// unsubmitted dispute is reminded once in the 72 to 96 hour band before its
// evidence deadline ("3 days") and once in the 24 to 48 hour band ("1 day"),
// skipping paused accounts, with outcomes dispute_reminder_3d and
// dispute_reminder_1d recorded. Its words are lib/disputes-email.ts (blob
// 156719f1), sendDisputeDeadlineReminderEmail.

const harness = vi.hoisted(() => ({
  db: null as unknown,
  seen: new Set<string>(),
  sent: [] as { to: string; subject: string; html: string }[],
}));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

vi.mock("~/lib/money/execute", () => ({
  executeMoneyWrite: async (_env: Env, write: { idempotencyKey: string; build: (db: unknown) => unknown[] }) => {
    if (harness.seen.has(write.idempotencyKey)) return { applied: false };
    await (harness.db as { batch: (s: unknown[]) => Promise<unknown> }).batch(write.build(harness.db));
    harness.seen.add(write.idempotencyKey);
    return { applied: true };
  },
}));

const { resolveReminderBucket, DISPUTE_REMINDER_TEMPLATE } = await import("~/lib/disputes/notices");
const { runDisputeReminders, DISPUTE_REMINDERS_CRON_NAME, REFUSED_REMINDER_BACKOFF_MS } = await import(
  "~/lib/cron/dispute-reminders"
);
const { CRON_JOBS } = await import("~/lib/cron/registry");

const NOW = new Date("2026-11-10T12:00:00Z");
const HOUR = 60 * 60 * 1000;

const env = {
  BETTER_AUTH_URL: "https://foxhoundapp.test",
  EMAIL: {
    send: async (m: { to: string; subject: string; html: string }) => {
      harness.sent.push(m);
      return { id: `msg_${harness.sent.length}` };
    },
  },
} as unknown as Env;

let sqlite: Database.Database;

beforeEach(() => {
  const made = createInMemoryDb();
  sqlite = made.sqlite;
  harness.db = made.db;
  harness.seen = new Set();
  harness.sent = [];
});

function seedAccount(id: string, opts: { paused?: boolean; liveSends?: boolean; email?: string | null } = {}) {
  sqlite
    .prepare(
      "INSERT INTO accounts (id, name, created_at, notification_email, processing_paused, live_sends_enabled) VALUES (?, 'Acme', 1000, ?, ?, ?)",
    )
    .run(id, opts.email === undefined ? `ops@${id}.test` : opts.email, opts.paused ? 1 : 0, opts.liveSends === false ? 0 : 1);
}

function seedDispute(
  id: string,
  accountId: string,
  hoursLeft: number | null,
  opts: { state?: string; submitted?: boolean } = {},
) {
  sqlite
    .prepare(
      "INSERT INTO disputes (id, account_id, stripe_dispute_id, stripe_charge_id, customer_name, amount_cents, currency, reason, status, state, evidence_deadline, submitted_at, created_at) VALUES (?, ?, ?, 'ch', 'Jane Buyer', 5000, 'usd', 'fraudulent', 'needs_response', ?, ?, ?, 1000)",
    )
    .run(
      id,
      accountId,
      `dp_${id}`,
      opts.state ?? "pending_review",
      hoursLeft === null ? null : NOW.getTime() + hoursLeft * HOUR,
      opts.submitted ? 2000 : null,
    );
}

function seedApproval(disputeId: string, accountId: string) {
  sqlite
    .prepare(
      "INSERT INTO dispute_approvals (id, dispute_id, account_id, approved_by_email, evidence_version_hash, approved_at) VALUES (?, ?, ?, 'owner@a1.test', 'hash', 1500)",
    )
    .run(`ap_${disputeId}`, disputeId, accountId);
}

function outcomeRows() {
  return sqlite
    .prepare("SELECT event_type AS type, outcome, product FROM outcomes ORDER BY event_type")
    .all() as { type: string; outcome: string; product: string }[];
}

describe("THE WINDOW: Recova's two bands, edges included", () => {
  it("72 to 96 hours is the 3-day reminder", () => {
    expect(resolveReminderBucket(96)).toBeNull();
    expect(resolveReminderBucket(95.9)).toEqual({ eventType: "dispute_reminder_3d", daysLeft: 3 });
    expect(resolveReminderBucket(72)).toEqual({ eventType: "dispute_reminder_3d", daysLeft: 3 });
    expect(resolveReminderBucket(71.9)).toBeNull();
  });

  it("24 to 48 hours is the 1-day reminder; nothing between or after", () => {
    expect(resolveReminderBucket(60)).toBeNull();
    expect(resolveReminderBucket(48)).toBeNull();
    expect(resolveReminderBucket(47.9)).toEqual({ eventType: "dispute_reminder_1d", daysLeft: 1 });
    expect(resolveReminderBucket(24)).toEqual({ eventType: "dispute_reminder_1d", daysLeft: 1 });
    expect(resolveReminderBucket(23.9)).toBeNull();
    expect(resolveReminderBucket(-5)).toBeNull();
  });
});

describe("THE RUN: who is reminded", () => {
  it("one reminder per dispute inside a band, in Recova's words", async () => {
    seedAccount("a1");
    seedDispute("d3", "a1", 80);
    seedDispute("d1", "a1", 30);
    seedDispute("dmid", "a1", 60);
    seedDispute("dlate", "a1", 10);
    seedDispute("dnone", "a1", null);

    const result = await runDisputeReminders(env, NOW);

    expect(result.sent).toBe(2);
    const subjects = harness.sent.map((m) => m.subject).sort();
    expect(subjects).toEqual(["URGENT: Dispute response due in 1 day", "URGENT: Dispute response due in 3 days"]);
    const three = harness.sent.find((m) => m.subject.endsWith("3 days"))!;
    expect(three.to).toBe("ops@a1.test");
    expect(three.html).toMatch(/<h1[^>]*>Dispute response due in 3 days\.<\/h1>/);
    // Capsomer's frame renders the paragraph without the bold run.
    expect(three.html).toContain("Jane Buyer disputed $50.00 for reason: Fraudulent.");
    expect(three.html).toContain("Current status: needs response.");
    expect(three.html).toContain("Auto-submit is off. You need to review and submit, or choose to accept.");
    expect(three.html).toContain("https://foxhoundapp.test/disputes/d3");
    expect(three.html.toLowerCase()).not.toContain("unsubscribe");

    const templates = sqlite.prepare("SELECT DISTINCT template FROM email_sends").all() as { template: string }[];
    expect(templates).toEqual([{ template: DISPUTE_REMINDER_TEMPLATE }]);
    // Recova's once-only marks, recorded as outcomes.
    expect(outcomeRows()).toEqual([
      { type: "dispute_reminder_1d", outcome: "sent", product: "disputes" },
      { type: "dispute_reminder_3d", outcome: "sent", product: "disputes" },
    ]);
  });

  it("a second tick in the same band sends nothing more", async () => {
    seedAccount("a1");
    seedDispute("d3", "a1", 80);
    await runDisputeReminders(env, NOW);
    await runDisputeReminders(env, new Date(NOW.getTime() + HOUR));
    expect(harness.sent).toHaveLength(1);
    expect(outcomeRows()).toHaveLength(1);
  });

  it("the same dispute is reminded again when it reaches the 1-day band", async () => {
    seedAccount("a1");
    seedDispute("d3", "a1", 80);
    await runDisputeReminders(env, NOW);
    await runDisputeReminders(env, new Date(NOW.getTime() + 48 * HOUR));
    expect(harness.sent.map((m) => m.subject)).toEqual([
      "URGENT: Dispute response due in 3 days",
      "URGENT: Dispute response due in 1 day",
    ]);
  });

  it("submitted, resolved, paused, unaddressed and switched-off accounts are not reminded", async () => {
    seedAccount("a1");
    seedAccount("apaused", { paused: true });
    seedAccount("anoaddr", { email: null });
    seedAccount("aoff", { liveSends: false });
    seedDispute("dsub", "a1", 80, { state: "submitted", submitted: true });
    seedDispute("dwon", "a1", 80, { state: "resolved_won" });
    seedDispute("dlost", "a1", 30, { state: "resolved_lost" });
    seedDispute("dp", "apaused", 80);
    seedDispute("dn", "anoaddr", 80);
    seedDispute("doff", "aoff", 80);

    const result = await runDisputeReminders(env, NOW);
    expect(result.sent).toBe(0);
    expect(harness.sent).toHaveLength(0);
    expect(outcomeRows()).toHaveLength(0);
  });

  it("a demo account is never reminded", async () => {
    seedAccount("demo_acct");
    seedDispute("dd", "demo_acct", 80);
    await runDisputeReminders(env, NOW);
    expect(harness.sent).toHaveLength(0);
  });
});

describe("PR 149 review: no dispute starves, and a tick repeats no work", () => {
  function emailSendCount(): number {
    return (sqlite.prepare("SELECT count(*) AS n FROM email_sends").get() as { n: number }).n;
  }

  it("more than the batch limit in a band: every dispute is reminded over the next ticks, soonest deadline first", async () => {
    seedAccount("a1");
    // 150 disputes in the 3-day band, the soonest deadlines planted last so
    // insertion order cannot pass for the deadline order.
    for (let i = 0; i < 150; i++) seedDispute(`d${String(i).padStart(3, "0")}`, "a1", 95 - i * 0.1);

    const first = await runDisputeReminders(env, NOW);
    expect(first).toMatchObject({ considered: 100, sent: 100 });
    // The 100 soonest went first: the 50 latest deadlines (d000 to d049) wait.
    const firstTo = new Set(harness.sent.map((m) => m.html.match(/disputes\/(d\d{3})/)![1]));
    expect([...firstTo].sort()[0]).toBe("d050");

    const second = await runDisputeReminders(env, NOW);
    expect(second).toMatchObject({ considered: 50, sent: 50 });
    const third = await runDisputeReminders(env, NOW);
    // Already reminded for its band: not selected at all, so no load, no
    // suppression check, no claim attempt and no row.
    expect(third).toEqual({ considered: 0, sent: 0, skipped: 0, failed: 0 });
    expect(harness.sent).toHaveLength(150);
    expect(emailSendCount()).toBe(150);
  });

  it("the gap between the bands is never selected, so it cannot crowd out a due dispute", async () => {
    seedAccount("a1");
    // 120 disputes 60 hours out (between the bands), planted first, and one due.
    for (let i = 0; i < 120; i++) seedDispute(`g${String(i).padStart(3, "0")}`, "a1", 60);
    seedDispute("due", "a1", 30);
    const result = await runDisputeReminders(env, NOW);
    expect(result).toMatchObject({ considered: 1, sent: 1 });
    expect(harness.sent[0].html).toContain("https://foxhoundapp.test/disputes/due");
  });

  it("a suppressed notification address is not selected, so no suppressed row is written each tick", async () => {
    seedAccount("a1");
    sqlite
      .prepare("INSERT INTO email_suppressions (id, email, token, suppressed_at, reason) VALUES ('s1', 'ops@a1.test', 't', 1000, 'bounce')")
      .run();
    seedDispute("d3", "a1", 80);
    for (let tick = 0; tick < 3; tick++) {
      expect(await runDisputeReminders(env, new Date(NOW.getTime() + tick * 5 * 60 * 1000))).toMatchObject({
        considered: 0,
      });
    }
    expect(harness.sent).toHaveLength(0);
    expect(emailSendCount()).toBe(0);
  });

  it("a send the provider refused is tried again on the next tick", async () => {
    seedAccount("a1");
    seedDispute("d3", "a1", 80);
    const send = (env.EMAIL as { send: unknown }).send;
    (env.EMAIL as { send: unknown }).send = async () => {
      throw new Error("provider down");
    };
    try {
      expect(await runDisputeReminders(env, NOW)).toMatchObject({ considered: 1, failed: 1 });
    } finally {
      (env.EMAIL as { send: unknown }).send = send;
    }
    // Tried again once the back-off (job_2663d92094ab) has passed.
    expect(await runDisputeReminders(env, new Date(NOW.getTime() + REFUSED_REMINDER_BACKOFF_MS))).toMatchObject({
      considered: 1,
      sent: 1,
    });
    expect(harness.sent).toHaveLength(1);
  });
});

describe("job_2663d92094ab: the reminder says only what the merchant can do", () => {
  it("an unapproved dispute keeps Recova's line: review and submit, or accept", async () => {
    seedAccount("a1");
    seedDispute("d3", "a1", 80);
    await runDisputeReminders(env, NOW);
    expect(harness.sent[0].html).toContain("You need to review and submit, or choose to accept.");
  });

  it("an approved dispute Stripe has not confirmed is still reminded, without offering Accept", async () => {
    seedAccount("a1");
    seedDispute("d3", "a1", 80, { state: "approved" });
    seedApproval("d3", "a1");
    const result = await runDisputeReminders(env, NOW);
    expect(result.sent).toBe(1);
    const html = harness.sent[0].html;
    expect(html).not.toContain("choose to accept");
    expect(html).not.toContain("review and submit");
    expect(html).toContain(
      "Your evidence is approved, but Stripe has not confirmed the submission. Check this dispute in Stripe, or open it in Foxhound to submit it again.",
    );
    expect(html).toContain("https://foxhoundapp.test/disputes/d3");
  });
});

describe("job_2663d92094ab: a refused reminder backs off instead of retrying every tick", () => {
  function attempts(): number {
    return harness.sent.length + refusals;
  }
  let refusals = 0;

  beforeEach(() => {
    refusals = 0;
    vi.useFakeTimers({ toFake: ["Date"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function tickAt(at: Date, refuse: boolean) {
    vi.setSystemTime(at);
    const send = (env.EMAIL as { send: unknown }).send;
    if (refuse) {
      (env.EMAIL as { send: unknown }).send = async () => {
        refusals++;
        throw new Error("provider refused");
      };
    }
    try {
      return await runDisputeReminders(env, at);
    } finally {
      (env.EMAIL as { send: unknown }).send = send;
    }
  }

  it("a refused send is not tried again until the back-off has passed", async () => {
    seedAccount("a1");
    seedDispute("d3", "a1", 90);
    expect(await tickAt(NOW, true)).toMatchObject({ considered: 1, failed: 1 });
    // The next ticks inside the back-off select nothing and call nobody.
    for (const minutes of [5, 10, 30, 55]) {
      expect(await tickAt(new Date(NOW.getTime() + minutes * 60 * 1000), true)).toMatchObject({ considered: 0 });
    }
    expect(attempts()).toBe(1);
    // Once it has passed, the reminder is tried again and goes out.
    expect(await tickAt(new Date(NOW.getTime() + REFUSED_REMINDER_BACKOFF_MS), false)).toMatchObject({
      considered: 1,
      sent: 1,
    });
    expect(harness.sent).toHaveLength(1);
  });

  it("a provider that refuses all day is asked at most once per back-off, not every five minutes", async () => {
    seedAccount("a1");
    seedDispute("d1", "a1", 47);
    // Every five-minute tick for the 23 hours the dispute stays in the 1-day band.
    for (let m = 0; m < 23 * 60; m += 5) {
      await tickAt(new Date(NOW.getTime() + m * 60 * 1000), true);
    }
    expect(refusals).toBeLessThanOrEqual(Math.ceil((23 * HOUR) / REFUSED_REMINDER_BACKOFF_MS));
    expect(refusals).toBeGreaterThan(1);
    expect(harness.sent).toHaveLength(0);
  });
});

describe("THE CRON: registered on a schedule that fires", () => {
  it("is in the registry, on a schedule wrangler.jsonc triggers", () => {
    const job = CRON_JOBS.find((j) => j.name === DISPUTE_REMINDERS_CRON_NAME);
    expect(job).toBeDefined();
    const wrangler = readFileSync(fileURLToPath(new URL("../wrangler.jsonc", import.meta.url)), "utf8");
    expect(wrangler).toContain(`"${job!.schedule}"`);
  });
});
