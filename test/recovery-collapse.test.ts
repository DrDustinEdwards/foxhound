import { drizzle } from "drizzle-orm/d1";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as schema from "~/db/schema";
import {
  buildRetryReconciliationBatch,
  reconcileRetryRecovery,
  upgradeMissedRetryAttributions,
} from "~/lib/recovery/record-recovery";
import type { ResolvedAttribution } from "~/lib/recovery/attribution";
import {
  SerialMoneyCommitter,
  type CommitRequest,
  type CommitResult,
  type CommitterDeps,
  type CompiledStatement,
} from "~/lib/money/serializer";
import { buildRecoverBatch, type WebhookClaimInput } from "~/lib/webhooks/batches";

import { createInMemoryDb, inMemoryMoneyWriter, runStatement } from "./helpers/inmemory-db";

// Only the real-schema cases below set this; the fake-D1 cases keep getDb as is.
const realDb = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("~/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/db")>();
  return { ...actual, getDb: (env: Env) => (realDb.db as ReturnType<typeof actual.getDb>) ?? actual.getDb(env) };
});

// Regression cover for the review's Finding 1 + 2 (recovery-executors-review.md):
// the invoice.payment_succeeded webhook is the sole recovery recorder and sole
// status-flipper; the retry executor only reconciles attribution (UPDATE-only,
// never inserts). This exercises the REAL SerialMoneyCommitter (the DO's core,
// not mocked) against a minimal fake D1 that enforces the two things that matter:
// the outcomes.idempotency_key UNIQUE constraint, and whole-batch atomicity
// (a throw discards every statement in that commit, nothing partially lands).
// This is deliberately NOT a generic SQL engine: it interprets exactly the
// statement shapes buildRecoverBatch/buildRetryReconciliationBatch compile to,
// verified against real .toSQL() output.

const now = new Date("2026-07-20T00:00:00.000Z");
const db = drizzle({} as never, { schema });

function compile(batch: unknown[]): CompiledStatement[] {
  return batch.map((item) => (item as { toSQL(): CompiledStatement }).toSQL());
}

interface FakeRow {
  attributionKind: string;
}

/** A minimal, faithful-enough D1: enforces the outcomes unique index and the
 *  webhook_events unique index, and applies every statement in a commit only if
 *  none of them would violate a constraint (mirrors db.batch()'s one transaction). */
function makeFakeD1() {
  const webhookEventIds = new Set<string>();
  const outcomesByKey = new Map<string, FakeRow>();
  const recoveredPaymentsByFp = new Map<string, FakeRow>();
  const failedPaymentStatus = new Map<string, string>();

  const findParam = (params: unknown[], prefix: string): string | undefined =>
    params.find((p): p is string => typeof p === "string" && p.startsWith(prefix));
  const KINDS = ["foxhound_retry", "card_update", "email_engaged", "stripe_baseline"];
  const findKind = (params: unknown[]): string | undefined => KINDS.find((k) => params.includes(k));

  const runBatch = async (statements: CompiledStatement[]): Promise<void> => {
    // Pass 1 (validate): would any statement in this ONE transaction violate a
    // real UNIQUE index? D1's batch() is all-or-nothing, so we must know before
    // applying anything.
    for (const s of statements) {
      if (/^insert into "webhook_events"/i.test(s.sql)) {
        const evtId = findParam(s.params, "evt_");
        if (evtId && webhookEventIds.has(evtId)) {
          throw new Error("D1_ERROR: UNIQUE constraint failed: webhook_events.stripe_event_id");
        }
      }
      if (/^insert into "outcomes"/i.test(s.sql)) {
        const key = findParam(s.params, "recovery:");
        if (key && outcomesByKey.has(key)) {
          throw new Error("D1_ERROR: UNIQUE constraint failed: outcomes.idempotency_key");
        }
      }
    }
    // Pass 2 (apply): nothing above threw, so the whole batch commits together.
    for (const s of statements) {
      if (/^insert into "webhook_events"/i.test(s.sql)) {
        const evtId = findParam(s.params, "evt_");
        if (evtId) webhookEventIds.add(evtId);
      } else if (/^update "failed_payments"/i.test(s.sql) && s.params.includes("recovered")) {
        const fpId = findParam(s.params, "fp_");
        if (fpId && (failedPaymentStatus.get(fpId) ?? "active") === "active") {
          failedPaymentStatus.set(fpId, "recovered");
        }
      } else if (/^insert into "recovered_payments"/i.test(s.sql)) {
        const fpId = findParam(s.params, "fp_");
        const kind = findKind(s.params);
        if (fpId && kind) recoveredPaymentsByFp.set(fpId, { attributionKind: kind });
      } else if (/^insert into "outcomes"/i.test(s.sql)) {
        const key = findParam(s.params, "recovery:");
        const kind = findKind(s.params);
        if (key && kind) outcomesByKey.set(key, { attributionKind: kind });
      } else if (/^update "recovered_payments"/i.test(s.sql)) {
        const fpId = findParam(s.params, "fp_");
        const row = fpId ? recoveredPaymentsByFp.get(fpId) : undefined;
        // Mirror the real WHERE: only upgrades a row that is not already foxhound_retry.
        if (row && row.attributionKind !== "foxhound_retry" && s.params.includes("foxhound_retry")) {
          row.attributionKind = "foxhound_retry";
        }
      } else if (/^update "outcomes"/i.test(s.sql)) {
        const key = findParam(s.params, "recovery:");
        const row = key ? outcomesByKey.get(key) : undefined;
        if (row && row.attributionKind !== "foxhound_retry" && s.params.includes("foxhound_retry")) {
          row.attributionKind = "foxhound_retry";
        }
      }
    }
  };

  const deps: CommitterDeps = {
    hasSeen: async () => false, // force every commit through the DB-level check (the authoritative layer)
    markSeen: async () => {},
    runBatch,
  };

  return {
    committer: new SerialMoneyCommitter(deps),
    isActive: (fpId: string) => (failedPaymentStatus.get(fpId) ?? "active") === "active",
    attributionOf: (fpId: string) => recoveredPaymentsByFp.get(fpId)?.attributionKind,
    outcomeAttributionOf: (fpId: string) => outcomesByKey.get(`recovery:${fpId}`)?.attributionKind,
  };
}

/** Wraps a SerialMoneyCommitter as the env.MONEY_WRITER binding executeMoneyWrite
 *  expects (a DO namespace with idFromName/get(id).commit), so the REAL
 *  reconcileRetryRecovery can be driven end-to-end against the fake D1. */
function envWithMoneyWriter(committer: SerialMoneyCommitter): Env {
  return {
    DB: {} as never, // executeMoneyWrite only compiles statements via .toSQL(), never queries this
    MONEY_WRITER: {
      idFromName: (name: string) => name,
      get: () => ({ commit: (request: CommitRequest): Promise<CommitResult> => committer.commit(request) }),
    },
  } as unknown as Env;
}

function claim(eventId: string): WebhookClaimInput {
  return {
    stripeEventId: eventId,
    eventType: "invoice.payment_succeeded",
    accountId: "acc_1",
    receivedAt: now,
    payload: {},
  };
}

function recoverBatch(eventId: string, attribution: ResolvedAttribution) {
  return compile(
    buildRecoverBatch(db, {
      claim: claim(eventId),
      accountId: "acc_1",
      failedPaymentId: "fp_1",
      amountPaidCents: 4200,
      currency: "usd",
      recoveredAt: now,
      attribution,
      recoveredByStepId: attribution.ref,
      recoveryMethod: attribution.kind,
      idempotencyKey: "fp_1",
    }),
  );
}

function reconciliationBatch() {
  return compile(
    buildRetryReconciliationBatch(db, {
      accountId: "acc_1",
      failedPaymentId: "fp_1",
      stepId: "step_1",
      recoveredAt: now,
    }),
  );
}

describe("recovery collapse: reverse race (webhook records before the executor's patch lands)", () => {
  it("the webhook's early baseline record does not block the status flip, and the executor's later reconcile upgrades it cleanly (no rollback)", async () => {
    const fake = makeFakeD1();

    // The webhook processes first and cannot yet see the succeeded retry step, so
    // it falls back to the free baseline attribution. The flip still applies.
    const webhookResult = await fake.committer.commit({
      idempotencyKey: "webhook:evt_1",
      statements: recoverBatch("evt_1", { kind: "stripe_baseline", ref: null }),
    });
    expect(webhookResult.applied).toBe(true);
    expect(fake.isActive("fp_1")).toBe(false); // flipped immediately, regardless of attribution
    expect(fake.attributionOf("fp_1")).toBe("stripe_baseline");

    // The executor's step patch lands moments later and it reconciles: this must
    // be a clean upgrade, not a throw/rollback, and must not touch the status flip.
    const reconcileResult = await fake.committer.commit({
      idempotencyKey: "recovery-reconcile:fp_1",
      statements: reconciliationBatch(),
    });
    expect(reconcileResult.applied).toBe(true);
    expect(fake.attributionOf("fp_1")).toBe("foxhound_retry"); // upgraded: was wrongly free, now billable
    expect(fake.outcomeAttributionOf("fp_1")).toBe("foxhound_retry");
    expect(fake.isActive("fp_1")).toBe(false); // the earlier flip is untouched, still recovered

    // A second, redundant reconcile (e.g. a redelivered cron tick) is a genuine
    // no-op: nothing left to upgrade, no error, no double-billing.
    const secondReconcile = await fake.committer.commit({
      idempotencyKey: "recovery-reconcile:fp_1",
      statements: reconciliationBatch(),
    });
    expect(secondReconcile.applied).toBe(true); // ran fine (0 rows touched this time)
    expect(fake.attributionOf("fp_1")).toBe("foxhound_retry");
  });

  it("a redelivered webhook event (Stripe retry) does not re-run or disturb the already-landed recovery", async () => {
    const fake = makeFakeD1();
    await fake.committer.commit({
      idempotencyKey: "webhook:evt_1",
      statements: recoverBatch("evt_1", { kind: "foxhound_retry", ref: "step_1" }),
    });
    expect(fake.isActive("fp_1")).toBe(false);

    // Stripe redelivers the SAME event (e.g. our 200 got lost in transit). This
    // fake's hasSeen is stubbed to always miss (it exists to prove the DB-level
    // backstop, not the DO fast path), so the replay reaches runBatch again; the
    // webhook_events unique index rejects it, the whole batch is discarded, and
    // the committer reports it as the idempotent no-op it is (not an error).
    const replay = await fake.committer.commit({
      idempotencyKey: "webhook:evt_1",
      statements: recoverBatch("evt_1", { kind: "foxhound_retry", ref: "step_1" }),
    });
    expect(replay.applied).toBe(false);
    // State from the first delivery is untouched by the failed replay.
    expect(fake.isActive("fp_1")).toBe(false);
    expect(fake.attributionOf("fp_1")).toBe("foxhound_retry");
  });
});

describe("recovery collapse: reconcileRetryRecovery's retry window", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("catches a webhook baseline write that lands in the gap between retry attempts", async () => {
    vi.useFakeTimers();
    const fake = makeFakeD1();
    const env = envWithMoneyWriter(fake.committer);

    const reconcile = reconcileRetryRecovery(env, {
      accountId: "acc_1",
      failedPaymentId: "fp_1",
      stepId: "step_1",
      recoveredAt: now,
    });

    // Attempt 0 (no delay) runs immediately: nothing recorded yet, a no-op.
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.attributionOf("fp_1")).toBeUndefined();

    // The webhook "arrives" in the gap before the next attempt: it could not yet
    // see the succeeded retry, so it records the free baseline.
    await fake.committer.commit({
      idempotencyKey: "webhook:evt_1",
      statements: recoverBatch("evt_1", { kind: "stripe_baseline", ref: null }),
    });
    expect(fake.attributionOf("fp_1")).toBe("stripe_baseline");

    // Advance through the remaining retry delays: a later attempt sees the
    // now-landed baseline row and upgrades it.
    await vi.advanceTimersByTimeAsync(1000);
    await reconcile;

    expect(fake.attributionOf("fp_1")).toBe("foxhound_retry");
    expect(fake.outcomeAttributionOf("fp_1")).toBe("foxhound_retry");
    expect(fake.isActive("fp_1")).toBe(false);
  });
});

describe("recovery collapse: a reconcile that changes nothing is not a reconcile", () => {
  afterEach(() => {
    realDb.db = null;
  });

  function seedBaselineRecovery() {
    const { sqlite, db } = createInMemoryDb();
    realDb.db = db;
    runStatement(sqlite, db.insert(schema.accounts).values({ id: "acc_1", name: "Acme" }));
    runStatement(
      sqlite,
      db.insert(schema.failedPayments).values({
        id: "fp_1",
        accountId: "acc_1",
        stripeEventId: "evt_intake",
        stripeInvoiceId: "in_1",
        stripeCustomerId: "cus_1",
        customerEmail: "c@example.com",
        amountCents: 4200,
        currency: "usd",
        declineCategory: "soft",
        status: "active",
        detectedAt: new Date(now.getTime() - 60_000),
      }),
    );
    runStatement(
      sqlite,
      db.insert(schema.recoverySteps).values({
        id: "step_1",
        accountId: "acc_1",
        failedPaymentId: "fp_1",
        stepType: "retry_1",
        scheduledAt: now,
        executedAt: now,
        result: "retry_succeeded",
      }),
    );
    const env = { MONEY_WRITER: inMemoryMoneyWriter(() => sqlite).binding } as unknown as Env;
    return { sqlite, db, env };
  }

  it("reports false when no recovery row exists yet, and the daily sweep later upgrades the late baseline once", async () => {
    const { sqlite, db, env } = seedBaselineRecovery();
    vi.useFakeTimers();
    const reconcile = reconcileRetryRecovery(env, {
      accountId: "acc_1",
      failedPaymentId: "fp_1",
      stepId: "step_1",
      recoveredAt: now,
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await reconcile).toBe(false);
    vi.useRealTimers();

    // The webhook lands after the reconcile window, unable to see the retry.
    for (const stmt of buildRecoverBatch(db, {
      claim: claim("evt_late"),
      accountId: "acc_1",
      failedPaymentId: "fp_1",
      amountPaidCents: 4200,
      currency: "usd",
      recoveredAt: now,
      attribution: { kind: "stripe_baseline", ref: null },
      recoveredByStepId: null,
      recoveryMethod: "stripe_baseline",
      idempotencyKey: "fp_1",
    })) {
      runStatement(sqlite, stmt);
    }

    const later = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    expect(await upgradeMissedRetryAttributions(env, later)).toEqual({ upgraded: 1, failed: [] });
    expect(await upgradeMissedRetryAttributions(env, later)).toEqual({ upgraded: 0, failed: [] });
    const [row] = await db.select().from(schema.recoveredPayments);
    expect(row.attributionKind).toBe("foxhound_retry");
    expect(row.attributionRef).toBe("step_1");
  });
});
