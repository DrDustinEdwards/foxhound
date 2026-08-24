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

const { runWinbackSends, queryDueWinbackSteps, claimStepSent, claimSequenceExhausted } =
  await import("~/lib/cron/winback");
const { buildWinbackEmail, winbackSubject } = await import("~/lib/recovery/winback-email");
const { verifyCardUpdateToken } = await import("~/lib/card-update/token");

const ACCOUNT = "acct_1";
const NOW = new Date("2026-11-01T12:00:00Z");
const DUE = new Date("2026-11-01T11:00:00Z");
const NOT_DUE = new Date("2026-11-02T11:00:00Z");
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
      // ONE LIVE CONNECTION PER STRIPE ACCOUNT (356). The Stripe account id is
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
  it("carries legacy's three subjects", () => {
    expect(winbackSubject({ stepNumber: 1, planName: "Pro" })).toBe(
      "We're sorry to see you go. Here's what you're missing.",
    );
    expect(winbackSubject({ stepNumber: 2, planName: "Pro" })).toBe("A quick update since you left");
    expect(winbackSubject({ stepNumber: 3, planName: "Pro" })).toBe(
      "Last chance to reactivate your account",
    );
  });

  it("substitutes every placeholder, including the resubscribe url", () => {
    const html = buildWinbackEmail({
      stepNumber: 1,
      customerName: "Jane",
      planName: "Pro",
      senderName: "Teamflow",
      resubscribeUrl: "https://foxhoundapp.test/p/tok",
    });

    expect(html).toContain("<p>Hi Jane,</p>");
    expect(html).toContain("your Pro subscription");
    expect(html).toContain('<a href="https://foxhoundapp.test/p/tok">Reactivate My Account</a>');
    expect(html).toContain("Thanks for being a customer,<br>Teamflow");
    // NOTHING is left unsubstituted.
    expect(html).not.toContain("{{");
  });

  it("uses legacy's fallbacks when the sequence has no name, plan or sender", () => {
    const html = buildWinbackEmail({
      stepNumber: 2,
      customerName: null,
      planName: null,
      senderName: null,
      resubscribeUrl: "u",
    });

    expect(html).toContain("<p>Hi there,</p>");
    expect(html).toContain("Thanks,<br>Support");
    expect(html).toContain("Come Back");
  });

  it("THE PLAN FALLBACK IS ASSERTED ON STEP ONE, the only body that names a plan", () => {
    // Steps 2 and 3 carry no {{plan_name}}, so a mutation to the plan fallback
    // was invisible until this reached the step that actually uses it.
    const html = buildWinbackEmail({
      stepNumber: 1,
      customerName: null,
      planName: null,
      senderName: null,
      resubscribeUrl: "u",
    });

    // Legacy's own output, awkwardness included: the template already says
    // "your {{plan_name}} subscription", so the fallback reads back doubled.
    // Ported verbatim rather than smoothed, because legacy is the spec.
    expect(html).toContain("cancelled your your subscription subscription");
  });

  it("step 3 carries legacy's last-chance label", () => {
    expect(buildWinbackEmail({
      stepNumber: 3,
      customerName: "Jane",
      planName: "Pro",
      senderName: "T",
      resubscribeUrl: "u",
    })).toContain(">Reactivate Now</a>");
  });
});

describe("PLANT 2: the candidate query is legacy's filter set", () => {
  it("selects a due step on an active sequence", async () => {
    seedSequence();
    seedStep();

    const due = await queryDueWinbackSteps(db, NOW);

    expect(due.map((d) => d.stepId)).toEqual(["st_1"]);
    expect(due[0].senderName).toBe("Teamflow");
    expect(due[0].planName).toBe("Pro");
  });

  it("skips a step that is not yet due", async () => {
    seedSequence();
    seedStep({ scheduledAt: NOT_DUE });

    expect(await queryDueWinbackSteps(db, NOW)).toEqual([]);
  });

  it("skips a step already executed", async () => {
    seedSequence();
    seedStep({ executedAt: DUE });

    expect(await queryDueWinbackSteps(db, NOW)).toEqual([]);
  });

  it("SKIPS A STEP WHOSE SEQUENCE IS NO LONGER ACTIVE", async () => {
    seedSequence({ status: "reactivated" });
    seedStep();

    expect(await queryDueWinbackSteps(db, NOW)).toEqual([]);
  });

  it("skips a step still inside its retry backoff", async () => {
    seedSequence();
    seedStep();
    sqlite.prepare("UPDATE win_back_steps SET next_retry_at = ? WHERE id = 'st_1'").run(NOT_DUE.getTime());

    expect(await queryDueWinbackSteps(db, NOW)).toEqual([]);
  });

  it("A DEMO ACCOUNT IS EXCLUDED AT THE QUERY, as legacy excludes it", async () => {
    seedAccount("demo_teamflow");
    seedSequence({ id: "wb_demo", accountId: "demo_teamflow" });
    seedStep({ id: "st_demo", sequenceId: "wb_demo", accountId: "demo_teamflow" });

    const due = await queryDueWinbackSteps(db, NOW);

    expect(due.map((d) => d.accountId)).not.toContain("demo_teamflow");
  });

  it("a paused account is excluded, and resumes later because nothing is stamped", async () => {
    seedSequence();
    seedStep();
    sqlite.prepare("UPDATE accounts SET processing_paused = 1 WHERE id = ?").run(ACCOUNT);

    expect(await queryDueWinbackSteps(db, NOW)).toEqual([]);
    await runWinbackSends(env, NOW);
    expect(stepRows()[0].result).toBeNull();
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
    const url = String(job.bodyHtml).match(/href="([^"]+)"/)?.[1] ?? "";
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

  it("A SECOND TICK SENDS NOTHING AND RECORDS NOTHING", async () => {
    seedSequence();
    seedStep();

    await runWinbackSends(env, NOW);
    const second = await runWinbackSends(env, new Date(NOW.getTime() + 60_000));

    expect(second).toEqual({ sent: 0, skipped: 0 });
    expect(harness.jobs).toHaveLength(1);
    expect(outcomeRows()).toHaveLength(1);
  });

  it("THE CLAIM IS REACHED ALONE: a step already claimed refuses a second claim", async () => {
    // The query filter and the claim are two independent layers. This reaches
    // the CLAIM on its own, by calling it twice against a live row (340
    // binding 3).
    seedSequence();
    seedStep();

    expect(await claimStepSent(db, "st_1", NOW)).toBe(true);
    expect(await claimStepSent(db, "st_1", new Date(NOW.getTime() + 60_000))).toBe(false);
  });

  it("NO recovered_payments AND NO recovery_steps ROW, ever", async () => {
    seedSequence();
    seedStep();

    await runWinbackSends(env, NOW);

    expect(sqlite.prepare("SELECT id FROM recovered_payments").all()).toEqual([]);
    expect(sqlite.prepare("SELECT id FROM recovery_steps").all()).toEqual([]);
  });
});

describe("PLANT 4: the refusals, each with legacy's result string", () => {
  it("THE TOGGLE IS NULL-IS-ON: a null toggle sends", async () => {
    seedSequence();
    seedStep();

    expect((await runWinbackSends(env, NOW)).sent).toBe(1);
  });

  it("an explicitly disabled account is stamped and never sent", async () => {
    seedAccount("acct_off", { toggle: 0 });
    seedSequence({ id: "wb_off", accountId: "acct_off" });
    seedStep({ id: "st_off", sequenceId: "wb_off", accountId: "acct_off" });

    const result = await runWinbackSends(env, NOW);

    expect(result).toEqual({ sent: 0, skipped: 1 });
    expect(harness.jobs).toEqual([]);
    expect(stepRows()[0].result).toBe("skipped_notifications_disabled");
    expect(outcomeRows()).toEqual([]);
  });

  it("an explicitly ENABLED account sends, so the toggle discriminates both ways", async () => {
    seedAccount("acct_on", { toggle: 1 });
    seedSequence({ id: "wb_on", accountId: "acct_on" });
    seedStep({ id: "st_on", sequenceId: "wb_on", accountId: "acct_on" });

    expect((await runWinbackSends(env, NOW)).sent).toBe(1);
  });

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

  it("a transient failure is not stamped either", async () => {
    seedSequence();
    seedStep();
    harness.outcome = { status: "failed" };

    await runWinbackSends(env, NOW);

    expect(stepRows()[0].result).toBeNull();
    expect(outcomeRows()).toEqual([]);
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

  it("THE FLIP'S STATUS CONDITION IS REACHED ALONE: it never clobbers a reactivation", async () => {
    // The due query already refuses a non-active sequence, so runWinbackSends
    // can never present one to the flip. Calling the flip directly is the only
    // way to prove its own condition, and the state it guards against is real:
    // a customer who reactivates between the query and the flip.
    seedSequence({ status: "reactivated" });

    await claimSequenceExhausted(db, "wb_1", NOW);

    expect(sequenceRows()[0].status).toBe("reactivated");
    expect(sequenceRows()[0].resolvedAt).toBeNull();
  });

  it("A REFUSED STEP 3 DOES NOT FLIP IT: the flip follows the claim, not the attempt", async () => {
    seedSequence();
    seedStep({ stepNumber: 3 });
    harness.outcome = { status: "suppressed" };

    await runWinbackSends(env, NOW);

    expect(sequenceRows()[0].status).toBe("active");
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

  it("THE CRON IS REGISTERED on the high-cadence schedule", async () => {
    const { CRON_JOBS } = await import("~/lib/cron/registry");
    const job = CRON_JOBS.find((j) => j.name === "winback-send");
    expect(job).toBeDefined();
    expect(job?.schedule).toBe("*/5 * * * *");
  });
});

describe("PLANT 7: the docs say what the engine now does", () => {
  it("the recovery guide describes the sequence, its exclusions, and that it is not billed", async () => {
    const { DOC_GUIDES } = await import("~/lib/marketing/docs-content");
    // RELOCATED, NOT WEAKENED. Session 64 moved these sentences into the
    // PLATFORM guide, which is where legacy documents both engines (its
    // Part 2, Additional features). The sentences are unchanged and so are
    // the assertions; only the guide they are found in moved.
    const platform = DOC_GUIDES.find((g) => g.slug === "platform");
    const section = platform?.sections.find((s) => s.heading === "Additional features");

    expect(section).toBeDefined();
    const body = (section?.body ?? [])
      .map((b) => (typeof b === "string" ? b : JSON.stringify(b)))
      .join(" ");
    // The schedule the cron actually sends on: 1h, 96h, 336h.
    expect(body).toContain("an hour after the cancellation");
    expect(body).toContain("four days");
    expect(body).toContain("fourteen");
    // The two gates the trigger really applies (290 to 292).
    expect(body).toContain("failing");
    expect(body).toContain("seven days");
    // 343 binding 1, stated to the merchant.
    expect(body).toContain("A reactivation is not billed");
  });
});
