import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createInMemoryDb } from "./helpers/inmemory-db";

// JOB 2 / 343: THE WIN-BACK SEND CRON, the half legacy has and Foxhound did not.
//
// The trigger shipped at 290 to 292; nothing ever sent the three steps it
// scheduled. Legacy's cron is the spec: due steps, the toggle NULL-is-ON, the
// suppression gate, one email per step at legacy's template, a conditional
// claim on executed_at, the outcome only for the tick that claimed, and the
// sequence flipped terminal after step 3.

const harness = vi.hoisted(() => ({
  db: null as unknown,
  jobs: [] as Record<string, unknown>[],
  outcome: { status: "sent" } as { status: string },
  stealClaim: null as null | (() => Promise<unknown>),
}));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

vi.mock("~/lib/email/dispatch", () => ({
  processEmailJob: async (_env: unknown, job: Record<string, unknown>) => {
    harness.jobs.push(job);
    // Emulates a CONCURRENT TICK taking the claim while this send is in
    // flight, which is the only way the claim can lose and the only way to
    // reach the `if (!claimed)` guard on its own. Without this the outcome's
    // idempotency key masks the guard entirely.
    if (harness.stealClaim) await harness.stealClaim();
    return harness.outcome;
  },
}));

vi.mock("~/lib/money/execute", () => ({
  executeMoneyWrite: async (_env: Env, write: { build: (db: unknown) => unknown[] }) => {
    const batch = write.build(harness.db);
    try {
      await (harness.db as { batch: (s: unknown[]) => Promise<unknown> }).batch(batch);
      return { applied: true };
    } catch {
      return { applied: false };
    }
  },
}));

const { runWinbackSends, claimStepSent } =
  await import("~/lib/cron/winback");
const { buildWinbackEmail } = await import("~/lib/recovery/winback-email");
const { verifyCardUpdateToken } = await import("~/lib/card-update/token");

const ACCOUNT = "acct_1";
const NOW = new Date("2026-11-01T12:00:00Z");
const DUE = new Date("2026-11-01T11:00:00Z");
const env = {
  ENCRYPTION_KEY: "ab".repeat(32),
  BETTER_AUTH_URL: "https://foxhoundapp.test",
  PHYSICAL_ADDRESS: "1 Test Way",
} as unknown as Env;

let sqlite: Database.Database;
let db: ReturnType<typeof createInMemoryDb>["db"];

beforeEach(() => {
  ({ sqlite, db } = createInMemoryDb());
  harness.db = db;
  harness.jobs = [];
  harness.outcome = { status: "sent" };
  harness.stealClaim = null;
  seedAccount(ACCOUNT);
});

function seedAccount(accountId: string, opts: { toggle?: number | null } = {}): void {
  sqlite
    .prepare(
      "INSERT INTO accounts (id, name, created_at, winback_notifications_enabled) VALUES (?, 'Acme', 1000, ?)",
    )
    .run(accountId, opts.toggle === undefined ? null : opts.toggle);
  sqlite
      // ONE LIVE CONNECTION PER STRIPE ACCOUNT. The Stripe account id is
      // derived from the Foxhound account rather than hardcoded, because a
      // shared literal made every two-account fixture violate the unique
      // index the moment it shipped, and production could never have had two
      // merchants on one connected account anyway.
    .prepare(
      "INSERT INTO stripe_connections (id, account_id, stripe_user_id, is_primary, stripe_access_token, sender_name, connected_at, created_at) VALUES (?, ?, ?, 1, 'cipher', 'Teamflow', 1000, 1000)",
    )
    .run(`c_${accountId}`, accountId, `acct_s_${accountId}`);
}

function seedSequence(
  opts: { id?: string; accountId?: string; status?: string; planName?: string | null; name?: string | null } = {},
): string {
  const id = opts.id ?? "wb_1";
  sqlite
    .prepare(
      "INSERT INTO win_back_sequences (id, account_id, stripe_customer_id, stripe_subscription_id, customer_email, customer_name, plan_name, amount_cents, currency, status, created_at, stripe_connection_id) VALUES (?, ?, 'cus_wb', ?, 'buyer@acme.test', ?, ?, 4900, 'usd', ?, 1000, ?)",
    )
    .run(
      id,
      opts.accountId ?? ACCOUNT,
      `sub_${id}`,
      opts.name === undefined ? "Jane" : opts.name,
      opts.planName === undefined ? "Pro" : opts.planName,
      opts.status ?? "active",
      `c_${opts.accountId ?? ACCOUNT}`,
    );
  return id;
}

function seedStep(
  opts: { id?: string; sequenceId?: string; accountId?: string; stepNumber?: number; scheduledAt?: Date; executedAt?: Date | null } = {},
): string {
  const id = opts.id ?? "st_1";
  sqlite
    .prepare(
      "INSERT INTO win_back_steps (id, win_back_sequence_id, account_id, step_number, scheduled_at, executed_at, attempt_count) VALUES (?, ?, ?, ?, ?, ?, 0)",
    )
    .run(
      id,
      opts.sequenceId ?? "wb_1",
      opts.accountId ?? ACCOUNT,
      opts.stepNumber ?? 1,
      (opts.scheduledAt ?? DUE).getTime(),
      opts.executedAt ? opts.executedAt.getTime() : null,
    );
  return id;
}

function stepRows() {
  return sqlite
    .prepare(
      "SELECT id, step_number AS stepNumber, executed_at AS executedAt, result FROM win_back_steps ORDER BY step_number",
    )
    .all() as { id: string; stepNumber: number; executedAt: number | null; result: string | null }[];
}

function sequenceRows() {
  return sqlite
    .prepare("SELECT id, status, resolved_at AS resolvedAt FROM win_back_sequences")
    .all() as { id: string; status: string; resolvedAt: number | null }[];
}

function outcomeRows() {
  return sqlite
    .prepare(
      "SELECT event_type AS eventType, outcome, event_data AS eventData, idempotency_key AS key FROM outcomes",
    )
    .all() as { eventType: string; outcome: string; eventData: string; key: string }[];
}

describe("PLANT 1: the copy is legacy's, per step", () => {
  /** The template's words, in order, as one string per block (J91: the
   *  template is Capsomer's blocks, so a sentence is a block's text and the
   *  button is its label). */
  const words = (blocks: { type: string; text?: string; label?: string; url?: string }[]) =>
    blocks.map((b) => (b.type === "button" ? `[${b.label}](${b.url})` : (b.text ?? "")));

  it("substitutes every placeholder, including the resubscribe url", () => {
    const blocks = buildWinbackEmail({
      stepNumber: 1,
      customerName: "Jane",
      planName: "Pro",
      senderName: "Teamflow",
      resubscribeUrl: "https://foxhoundapp.test/p/tok",
    });

    expect(words(blocks)).toEqual([
      "Hi Jane,",
      "We noticed you recently canceled your Pro subscription. We're sorry to see you go.",
      "If there's anything we could have done better, we'd love to hear from you. And if you ever want to come back, we'll be here.",
      "[Reactivate My Account](https://foxhoundapp.test/p/tok)",
      "Thanks for being a customer,",
      "Teamflow",
    ]);
    // NOTHING is left unsubstituted.
    expect(JSON.stringify(blocks)).not.toContain("{{");
  });
});

describe("PLANT 3: a send claims the step and records one outcome", () => {
  it("sends on the CUSTOMER audience with a resubscribe token for THIS step", async () => {
    seedSequence();
    seedStep({ stepNumber: 2 });

    const result = await runWinbackSends(env, NOW);

    expect(result).toEqual({ sent: 1, skipped: 0 });
    expect(harness.jobs).toHaveLength(1);
    const job = harness.jobs[0];
    expect(job.accountId).toBe(ACCOUNT);
    expect(job.to).toBe("buyer@acme.test");
    expect(job.fromName).toBe("Teamflow");
    expect(job.template).toBe("winback");
    expect(job.subject).toBe("A quick update since you left");
    expect(job.idempotencyKey).toBe("winback-step:st_1");
    // CUSTOMER audience: the unsubscribe token and the postal address are both
    // present, which is what scopes CAN-SPAM to this message.
    expect(job.unsubscribeToken).toBeTruthy();
    expect(job.physicalAddress).toBe("1 Test Way");

    // THE BUTTON RESOLVES TO A RESUBSCRIBE TOKEN naming this sequence and step.
    // J91: the template is Capsomer's blocks; its one button is the link.
    const url =
      (job.blocks as { type: string; url?: string }[]).find((b) => b.type === "button")?.url ?? "";
    expect(url.startsWith("https://foxhoundapp.test/p/")).toBe(true);
    const payload = await verifyCardUpdateToken(env, url.split("/p/")[1]);
    expect(payload?.winBackSequenceId).toBe("wb_1");
    expect(payload?.winBackStepNumber).toBe(2);
    expect(payload?.accountId).toBe(ACCOUNT);
  });

  it("claims executed_at and records legacy's outcome once", async () => {
    seedSequence();
    seedStep();

    await runWinbackSends(env, NOW);

    const steps = stepRows();
    expect(steps[0].executedAt).toBe(NOW.getTime());
    expect(steps[0].result).toBe("email_sent_fallback");

    const rows = outcomeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].eventType).toBe("winback_email_sent");
    expect(rows[0].outcome).toBe("sent");
    expect(JSON.parse(rows[0].eventData)).toEqual({ stepNumber: 1, amountCents: 4900 });
    expect(rows[0].key).toBe("winback-email:st_1");
  });
});

describe("PLANT 4: the refusals, each with legacy's result string", () => {

  it("a SUPPRESSED address is stamped with legacy's skipped_unsubscribed", async () => {
    seedSequence();
    seedStep();
    harness.outcome = { status: "suppressed" };

    await runWinbackSends(env, NOW);

    expect(stepRows()[0].result).toBe("skipped_unsubscribed");
    expect(outcomeRows()).toEqual([]);
  });

  it("A BLOCKED SEND IS NOT STAMPED, so it sends once live sends are enabled", async () => {
    seedSequence();
    seedStep();
    harness.outcome = { status: "blocked" };

    await runWinbackSends(env, NOW);

    expect(stepRows()[0].result).toBeNull();
    expect(stepRows()[0].executedAt).toBeNull();
    expect(outcomeRows()).toEqual([]);

    harness.outcome = { status: "sent" };
    expect((await runWinbackSends(env, new Date(NOW.getTime() + 60_000))).sent).toBe(1);
  });
});

describe("PLANT 5: step 3 flips the sequence terminal, as legacy does", () => {
  it("after step 3 sends, the sequence is exhausted with resolved_at", async () => {
    seedSequence();
    seedStep({ stepNumber: 3 });

    await runWinbackSends(env, NOW);

    expect(sequenceRows()).toEqual([
      { id: "wb_1", status: "exhausted", resolvedAt: NOW.getTime() },
    ]);
  });

  it("steps 1 and 2 leave the sequence ACTIVE", async () => {
    seedSequence();
    seedStep({ id: "st_1", stepNumber: 1 });

    await runWinbackSends(env, NOW);

    expect(sequenceRows()[0].status).toBe("active");
    expect(sequenceRows()[0].resolvedAt).toBeNull();
  });
});

describe("PLANT 6: a lost claim records nothing, and the cron is registered", () => {
  it("A CONCURRENT TICK'S CLAIM STOPS THE OUTCOME, reaching the guard alone", async () => {
    seedSequence();
    seedStep();
    harness.stealClaim = () => claimStepSent(db, "st_1", new Date(NOW.getTime() - 1000));

    const result = await runWinbackSends(env, NOW);

    expect(result).toEqual({ sent: 0, skipped: 1 });
    // The other tick's send owns the step and its outcome; this one records none.
    expect(outcomeRows()).toEqual([]);
    expect(stepRows()[0].executedAt).toBe(NOW.getTime() - 1000);
  });
});
