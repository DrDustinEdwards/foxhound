import { and, eq } from "drizzle-orm";
import { accounts, cronConfig, disputes, getDb } from "~/db";
import { RECOVERY_TICK_CRON_NAME, RETRY_TOKEN_MAX_ATTEMPTS } from "~/lib/constants";
import { recordOutcome } from "~/lib/engine/outcomes";
import { buildRetryAttemptPatch } from "~/lib/engine/retry-step";
import { afterTransientFailureWith } from "~/lib/recovery/step-state";
import { accountProcessingEligibleCondition, type DueStepRow } from "./due-steps";

import { errorMessage } from "@dustinedwards/site-runtime/log";
/** What the loop re-checks before EACH step. */
export interface TickGuards {
  /** recovery-tick's cron_config flag. A missing row means enabled. */
  tickEnabled: boolean;
  /** Whether this step's account is STILL processing-eligible right now. */
  accountEligible: boolean;
}

/**
 * Re-read both gates as of this instant, in ONE db.batch (a batch is a single
 * round trip, so this costs one subrequest per step rather than two).
 *
 * The account predicate is the SAME accountProcessingEligibleCondition the
 * selection query uses, re-evaluated, so the two can never disagree about what
 * eligible means.
 */
export async function checkTickGuards(env: Env, accountId: string): Promise<TickGuards> {
  const db = getDb(env);
  const results = await db.batch([
    db
      .select({ enabled: cronConfig.enabled })
      .from(cronConfig)
      .where(eq(cronConfig.cronName, RECOVERY_TICK_CRON_NAME))
      .limit(1),
    db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.id, accountId), accountProcessingEligibleCondition()))
      .limit(1),
  ]);

  // Both halves fail CLOSED, which they did not before. The account half
  // meanwhile failed closed by accident (a non-array would throw on .length).
  // One guard should not fail in two directions, so the shape is now checked
  // and anything unexpected throws, which the caller treats as a halt.
  const [cfgRows, acctRows] = results as [unknown, unknown];
  if (!Array.isArray(cfgRows) || !Array.isArray(acctRows)) {
    throw new Error("checkTickGuards: unexpected batch result shape");
  }
  const cfg = cfgRows[0] as { enabled?: unknown } | undefined;
  if (cfg !== undefined && typeof cfg.enabled !== "boolean") {
    throw new Error("checkTickGuards: cron_config.enabled is not a boolean");
  }

  return {
    // Absent row means enabled; a present row must say so explicitly.
    tickEnabled: cfg === undefined ? true : (cfg.enabled as boolean),
    accountEligible: acctRows.length > 0,
  };
}

/**
 * The terminal result stamped on a retry step that can never run: the account's
 * connection is gone or was never stored, so there is no token to charge with.
 */
export const RETRY_RESULT_NO_CONNECTION = "retry_no_connection";

/**
 * Record one failed attempt to run a retry step that has no usable connected
 * token, with BOUNDED GRACE: reschedule with backoff until
 * RETRY_TOKEN_MAX_ATTEMPTS, then stamp terminal.
 *
 * Originally the tick did `continue` with no write at all, leaving the step
 * unexecuted with a null result, which is exactly what stepDueCondition
 * selects: the same step was re-read and re-skipped every five minutes forever,
 * and its sequence could never exhaust.
 */
export async function recordMissingTokenAttempt(
  env: Env,
  step: { stepId: string; attemptCount: number },
  now: Date,
): Promise<string | null> {
  const patch = afterTransientFailureWith(step.attemptCount, "no connected stripe token", now, {
    maxAttempts: RETRY_TOKEN_MAX_ATTEMPTS,
    terminalResult: RETRY_RESULT_NO_CONNECTION,
  });
  const db = getDb(env);
  await db.batch([buildRetryAttemptPatch(db, step.stepId, patch)]);
  return patch.result;
}

/**
 * The terminal result on a retry step skipped because the customer has a lost
 * dispute with this account.
 */
const RETRY_RESULT_DISPUTE_LOST = "retry_skipped_dispute_lost";

/**
 * Whether this customer has a dispute with this account that the merchant lost.
 * Read from the disputes table, not a customer_context flag, because the
 * Intelligence sync rebuilds that row and would drop a flag it does not own.
 */
export async function hasLostDispute(
  env: Env,
  accountId: string,
  stripeCustomerId: string,
): Promise<boolean> {
  try {
    const rows = await getDb(env)
      .select({ id: disputes.id })
      .from(disputes)
      .where(
        and(
          eq(disputes.accountId, accountId),
          eq(disputes.stripeCustomerId, stripeCustomerId),
          eq(disputes.state, "resolved_lost"),
        ),
      )
      .limit(1);
    return rows.length > 0;
  } catch (err) {
    console.error("lost-dispute check failed, retry proceeds:", errorMessage(err));
    return false;
  }
}

export async function suppressRetryForLostDispute(
  env: Env,
  row: Pick<DueStepRow, "stepId" | "stepType" | "accountId" | "attemptCount"> & {
    stripeCustomerId: string;
  },
  now: Date,
): Promise<void> {
  const db = getDb(env);
  await db.batch([
    buildRetryAttemptPatch(db, row.stepId, {
      attemptCount: row.attemptCount,
      lastAttemptError: null,
      nextRetryAt: null,
      executedAt: now,
      result: RETRY_RESULT_DISPUTE_LOST,
    }),
  ]);
  await recordOutcome(env, {
    accountId: row.accountId,
    product: "recovery",
    eventType: "recovery_retry_suppressed",
    eventData: {
      step_id: row.stepId,
      step_type: row.stepType,
      stripe_customer_id: row.stripeCustomerId,
      reason: "dispute_lost",
    },
    outcome: "suppressed",
    outcomeAt: now,
    idempotencyKey: `recovery_retry_suppressed_${row.stepId}`,
  });
}
