import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DisputeSubmissionContext } from "~/lib/disputes/submission";

import { createInMemoryDb } from "./helpers/inmemory-db";

// Recova's opt-in dispute auto-submit: app/api/cron/process-disputes/route.ts
// (blob 1cbd5bd0) "Thing 2" and lib/disputes-email.ts (blob 156719f1)
// sendDisputeAutoSubmittedEmail. Inside 24 hours of the evidence deadline, an
// unsubmitted dispute on an account that turned auto-submit on is submitted
// through the approval gate, on the merchant's standing opt-in; nothing else is.

const harness = vi.hoisted(() => ({
  db: null as unknown,
  seen: new Set<string>(),
  sent: [] as { to: string; subject: string; html: string }[],
  submitted: [] as unknown[],
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

// Stripe's side of the one submission path, recorded instead of called.
vi.mock("~/lib/disputes/submission", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/disputes/submission")>()),
  submitDisputeEvidence: async (_env: Env, ctx: DisputeSubmissionContext) => {
    harness.submitted.push(ctx);
    return { ok: true };
  },
}));

const { applyDisputeSettings, applyDisputesEnabled } = await import("~/lib/settings/apply.server");
const { CRON_JOBS } = await import("~/lib/cron/registry");
const { DISPUTE_REMINDERS_CRON_NAME } = await import("~/lib/cron/dispute-reminders");

const NOW = new Date("2026-11-10T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const OPTED_IN_AT = new Date("2026-11-01T09:00:00Z");

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
let db: ReturnType<typeof createInMemoryDb>["db"];

beforeEach(() => {
  ({ sqlite, db } = createInMemoryDb());
  harness.db = db;
  harness.seen = new Set();
  harness.sent = [];
  harness.submitted = [];
});

/** An account with a connection, auto-submit set through the settings writer
 *  (the only way it is set), so the opt-in is recorded as a merchant makes it. */
async function seedAccount(id: string, opts: { autoSubmit: boolean; paused?: boolean }) {
  sqlite
    .prepare(
      "INSERT INTO accounts (id, name, created_at, notification_email, processing_paused, live_sends_enabled) VALUES (?, 'Acme', 1000, ?, ?, 1)",
    )
    .run(id, `ops@${id}.test`, opts.paused ? 1 : 0);
  sqlite
    .prepare(
      "INSERT INTO stripe_connections (id, account_id, stripe_user_id, is_primary, stripe_access_token, connected_at, created_at) VALUES (?, ?, ?, 1, 'cipher', 1000, 1000)",
    )
    .run(`conn_${id}`, id, `acct_stripe_${id}`);
  await applyDisputeSettings(
    db,
    id,
    { productDescription: "Candles", shipsPhysical: false, autoSubmit: opts.autoSubmit },
    { userId: `user_${id}`, email: `owner@${id}.test`, now: OPTED_IN_AT },
  );
}

function seedDispute(id: string, accountId: string, hoursLeft: number) {
  sqlite
    .prepare(
      "INSERT INTO disputes (id, account_id, stripe_connection_id, stripe_dispute_id, stripe_charge_id, customer_name, amount_cents, currency, reason, status, state, evidence_deadline, created_at) VALUES (?, ?, ?, ?, 'ch', 'Jane Buyer', 5000, 'usd', 'fraudulent', 'needs_response', 'pending_review', ?, 1000)",
    )
    .run(id, accountId, `conn_${accountId}`, `dp_${id}`, NOW.getTime() + hoursLeft * HOUR);
  sqlite
    .prepare(
      "INSERT INTO dispute_evidence (id, dispute_id, account_id, field_name, field_value, created_at) VALUES (?, ?, ?, 'uncategorized_text', 'Delivered and used.', 1000)",
    )
    .run(`ev_${id}`, id, accountId);
}

async function tick() {
  const job = CRON_JOBS.find((j) => j.name === DISPUTE_REMINDERS_CRON_NAME)!;
  vi.setSystemTime(NOW);
  try {
    return await job.handler(env, { runId: null } as never);
  } finally {
    vi.useRealTimers();
  }
}

describe("auto-submit fires inside 24 hours, only on a standing opt-in, through the approval gate", () => {
  it("submits the opted-in account's due dispute and nothing else", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await seedAccount("on", { autoSubmit: true });
    await seedAccount("off", { autoSubmit: false });
    await seedAccount("paused", { autoSubmit: true, paused: true });
    await seedAccount("disabled", { autoSubmit: true });
    await applyDisputesEnabled(db, "disabled", { enabled: false });

    seedDispute("due", "on", 10);
    seedDispute("early", "on", 30); // outside the 24 hours
    seedDispute("past", "on", -1); // deadline gone
    seedDispute("off_due", "off", 10);
    seedDispute("paused_due", "paused", 10);
    seedDispute("disabled_due", "disabled", 10);

    await tick();

    // Stripe was asked once, for the one due dispute, with its staged evidence.
    expect(harness.submitted).toEqual([
      expect.objectContaining({ stripeDisputeId: "dp_due", evidence: { uncategorized_text: "Delivered and used." } }),
    ]);

    // The approval row names the merchant who opted in, and when.
    const approvals = sqlite
      .prepare(
        "SELECT dispute_id AS d, approved_by_user_id AS u, approved_by_email AS e, standing_opt_in_at AS optIn FROM dispute_approvals",
      )
      .all();
    expect(approvals).toEqual([{ d: "due", u: "user_on", e: "owner@on.test", optIn: OPTED_IN_AT.getTime() }]);

    // Submitted as Foxhound's, which is what billing reads.
    const states = sqlite
      .prepare("SELECT id, state, submitted_at AS at, submitted_by AS by FROM disputes ORDER BY id")
      .all() as { id: string; state: string; at: number | null; by: string | null }[];
    expect(states.find((s) => s.id === "due")).toEqual({ id: "due", state: "submitted", at: NOW.getTime(), by: "foxhound_auto" });
    expect(states.filter((s) => s.id !== "due").every((s) => s.at === null && s.state === "pending_review")).toBe(true);

    expect(
      sqlite.prepare("SELECT event_type AS t, outcome AS o FROM outcomes WHERE event_type LIKE 'dispute_auto%'").all(),
    ).toEqual([{ t: "dispute_auto_submitted", o: "submitted" }]);
    const notice = harness.sent.find((m) => m.subject === "Dispute response submitted: $50.00");
    expect(notice?.to).toBe("ops@on.test");
    // The 1-day reminder on the dispute still outside the window says so.
    const reminder = harness.sent.find((m) => m.to === "ops@on.test" && m.subject.startsWith("URGENT"));
    expect(reminder?.html).toContain("Auto-submit is on. We will submit at the 24-hour mark");

    // The next tick finds nothing left to submit.
    vi.useFakeTimers({ toFake: ["Date"] });
    await tick();
    expect(harness.submitted).toHaveLength(1);
  });
});
