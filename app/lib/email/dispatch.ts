import { sha256Hex } from "@dustinedwards/site-runtime/encoding";
import { and, eq, isNotNull } from "drizzle-orm";

import type { Db } from "~/db";
import { accounts, getDb, emailSends } from "~/db";
import { isUniqueConstraintError } from "~/lib/money/serializer";

import { redactSecrets, sendEmail } from "./send";
import { isSuppressed } from "./suppression";
import type { OutboundEmailJob } from "./types";

// Email dispatch: suppression gate -> send -> email_sends log.
//
// Corrected 2026-08-11. This header used to describe "producer (enqueue onto
// the Queue) + consumer orchestration" as though the queue were the live path.
// It is not, and measurement said so: enqueueEmail had ZERO call sites in this
// repository, so nothing ever put a message on foxhound-email.
//
// THE PRODUCER IS DELETED 2026-08-14 under ruling 280 as amended by 281a. The
// `enqueueEmail` export and the EMAIL_QUEUE producer binding are gone, deadness
// re-measured at HEAD 937ac0c over all 567 tracked files with an untruncated
// git grep: zero callers, zero producers into foxhound-email anywhere, zero
// references in tests. The CONSUMER stays: consumer.ts also serves
// foxhound-email-events, which is the bounce and complaint path core.md's
// blocker 6 depends on, and its own instruction is "do not rebuild the
// consumer". So the queue registration is what keeps that handler reachable.
//
// The LIVE path bypasses the queue entirely and is synchronous inside the
// 5-minute recovery cron:
//
//   runRecoveryTick -> executeEmailStep -> defaultSend -> processEmailJob
//     -> sendEmail -> env.EMAIL (Cloudflare Email Service binding)
//
// defaultSend is at app/lib/engine/execute-step.ts:370 and passes
// queueMessageId = null, which is how a row in email_sends distinguishes the
// two paths. Retries on the live path come from decideEmailStep's backoff, not
// from the queue.

export type EmailSendStatus = "sent" | "suppressed" | "failed" | "blocked" | "pending" | "duplicate";

/** email_sends.error for a claim that reached the provider and never came back
 *  with an answer. Not used as a status: the ROW stays `pending`, because
 *  "pending" is the honest word for a send whose outcome nobody knows. */
const SEND_CLAIM_MISSING_KEY_ERROR = "email job has no idempotency key";

/** email_sends.error for a send the live-send flag refused. A stable string so
 *  "how many sends did the flag stop" is one WHERE clause, not a guess. */
export const LIVE_SENDS_DISABLED_ERROR = "live sends are disabled for this account";

export interface EmailJobResult {
  status: EmailSendStatus;
  providerMessageId: string | null;
  error: string | null;
  /** True when the queue message should be retried (transient send failure). */
  retryable: boolean;
}

/** SHA-256 hex of a recipient address; email_sends stores this, never the raw address. */
export function hashRecipient(email: string): Promise<string> {
  return sha256Hex(email.trim().toLowerCase());
}

/** The email_sends log row for a completed job. Pure; compile-tested. */
export function buildEmailSendRow(
  db: Db,
  input: {
    job: OutboundEmailJob;
    status: EmailSendStatus;
    providerMessageId: string | null;
    error: string | null;
    recipientHash: string;
    queueMessageId: string | null;
    now: Date;
    /** Set ONLY on the claim row (385). Suppressed and blocked rows leave it
     *  null on purpose: a blocked row is the live-send flag refusing, and a key
     *  on it would mean switching the merchant on finds the claim and skips the
     *  send forever. */
    idempotencyKey?: string | null;
  },
) {
  return db.insert(emailSends).values({
    idempotencyKey: input.idempotencyKey ?? null,
    accountId: input.job.accountId,
    recoveryStepId: input.job.recoveryStepId ?? null,
    winBackStepId: input.job.winBackStepId ?? null,
    queueMessageId: input.queueMessageId,
    template: input.job.template,
    recipientHash: input.recipientHash,
    status: input.status,
    providerMessageId: input.providerMessageId,
    error: input.error,
    sentAt: input.status === "sent" ? input.now : null,
    cronRunId: input.job.cronRunId ?? null,
    createdAt: input.now,
  });
}

// THE BINDING PRE-CONDITION IS NOW SATISFIED. Ratified 2026-08-09 (9766ff5),
// rescoped 2026-08-11 after measuring which path is live, BUILT here by S7 Phase 2
// Session D under ruling 268, and this is now its SOLE anchor.
//
// THE ANCHOR MOVED HERE 2026-08-14, per ruling 281a's requirement that
// 9766ff5's precondition comment move with the deletion rather than die. It was
// attached to `enqueueEmail`, which is deleted under 280. Its surviving
// substance, which existed nowhere else, is carried in full:
//
//   The precondition read "when it is wired to anything, the send gate lands in
//   the SAME commit: a per-account live flag, defaulting OFF, checked in
//   processEmailJob. Not a follow-up, not a separate PR." It was written on the
//   PRODUCER because that was the seam expected to be wired first. It never was.
//   What it guarded against, recorded because the blast radius is the reason the
//   precondition existed: accounts are eligible by default (processing_paused
//   defaults false) and the recovery cron is enabled by default when its config
//   row is absent, so on the day PHYSICAL_ADDRESS is set, every eligible account
//   would have mailed at once. The precondition always pointed HERE anyway, in
//   its own words: "wiring this producer does not satisfy it; the flag has to be
//   checked where the send actually happens."
//
// What it asked for: a per-account live flag, defaulting OFF, checked in THIS
// function before sendEmail. processEmailJob is the live path (the recovery cron
// calls it synchronously via defaultSend); the deleted producer was on no path at
// all, so gating it would have gated nothing.
//
// Why it was scheduled rather than triggered: 9766ff5's own condition was "the
// same commit as whatever first makes live sends reachable", and ruling 267
// established that the CRON had already passed that point before the ratification
// was written. The letter could therefore never fire again, and its purpose, a
// per-account control existing before any real merchant's sends, would have died
// with it. 268 decoupled the two and scheduled the flag here.
//
// What it replaces: an unset PHYSICAL_ADDRESS secret, which throws a CAN-SPAM
// error in buildEmailMessage (send.ts:33-38) before the EMAIL binding is reached.
// That is a compliance guard doing duty as a kill switch. It was never chosen as
// one, it is documented as one nowhere, and it is a single populated env var away
// from every eligible account mailing at once.
//
// SEMANTICS, and the consequence is stated rather than hidden. A blocked send is
// reported as a TRANSIENT failure, because it is true (no mail left) and because
// the alternative would be a lie: reporting ok would land the step on `email_sent`
// with nothing sent. sendResultToAttempt already treats any non-sent, non-
// suppressed status as a retryable failure, so no executor semantics change here,
// which ruling 268 forbids without a design ruling. The consequence is that a
// step belonging to a flag-off account will back off and, after SEND_MAX_ATTEMPTS,
// go terminal as `email_failed`. That is bounded and cannot fire today (see
// below), but it is the reason a future hardening pass may want this gate in the
// account-eligibility predicate rather than at the send site.
//
// WHO THIS AFFECTS TODAY: nobody. The demo account is excluded from the cron
// twice over before the flag is even read, by `processingPaused: true` from the
// seeder and by the DEMO_ACCOUNT_ID_PREFIX exclusion in
// accountProcessingEligibleCondition, and every mutating demo request is 405'd at
// the app-shell middleware. There are no live merchants. The flag defaults OFF
// for every row, existing and new.

/**
 * Process one queued email job: suppression gate, then send, then log. A
 * suppressed recipient is a terminal success (logged, no send, no retry). A send
 * failure is retryable (the queue redelivers up to its retry ceiling, then
 * dead-letters). Returns the result so the consumer can ack vs retry.
 *
 * queueMessageId is null on the live cron path and set only when a real queue
 * consumer delivers the job, which nothing currently does.
 */
export async function processEmailJob(
  env: Env,
  job: OutboundEmailJob,
  queueMessageId: string | null,
): Promise<EmailJobResult> {
  const db = getDb(env);
  const now = new Date();
  const recipientHash = await hashRecipient(job.to);

  if (await isSuppressed(env, job.to)) {
    await logSend(db, {
      job,
      status: "suppressed",
      providerMessageId: null,
      error: null,
      recipientHash,
      queueMessageId,
      now,
    });
    return { status: "suppressed", providerMessageId: null, error: null, retryable: false };
  }

  // THE LIVE-SEND GATE (268). After suppression, before the send: an account that
  // has not been switched on never reaches env.EMAIL. Logged like any other
  // outcome so the block is visible in email_sends rather than silent.
  //
  // PREVIEW MAIL IS NOT HELD (E3). The gate keeps a merchant's CUSTOMERS from
  // being mailed before the merchant is switched on. A preview goes only to the
  // signed-in user's own address (RULES.md 4.7) and reaches no customer, and
  // Recova's test-email route sends on every click with no such switch. The
  // admin email tool skips the gate for the same reason (#82).
  //
  // A JOB MARKED liveSendGate "skip" IS NOT HELD EITHER (E24, review round 1 of
  // PR 160): platform-to-merchant mail whose caller already refused demo and
  // ineligible accounts. Recova has no such switch for that mail, and the
  // switch is off for every real merchant today.
  if (
    job.audience !== "preview" &&
    job.liveSendGate !== "skip" &&
    !(await liveSendsEnabled(db, job.accountId))
  ) {
    await logSend(db, {
      job,
      status: "blocked",
      providerMessageId: null,
      error: LIVE_SENDS_DISABLED_ERROR,
      recipientHash,
      queueMessageId,
      now,
    });
    return {
      status: "blocked",
      providerMessageId: null,
      error: LIVE_SENDS_DISABLED_ERROR,
      retryable: true,
    };
  }

  // THE SEND CLAIM (385), and it is written BEFORE the provider call.
  //
  // WHAT IT CLOSES. 385 ruled the step-level send-then-claim order stays on both
  // the recovery and win-back paths, and named the residual it leaves: a worker
  // killed between the provider accepting and the step being claimed re-sends
  // once the lock's lease lapses, because nothing recorded that the mail had
  // gone. That residual cannot be closed at the step layer, because whatever the
  // step writes is written after the send too. It closes here, one layer down:
  // the row exists before the provider is called, so a worker that dies at any
  // point after this line leaves evidence behind.
  //
  // THE UNIQUE INDEX IS THE GUARD, not this read. There is no check-then-act
  // here: the insert either wins or violates `email_sends_idempotency_uq`, so
  // two workers racing on the same key cannot both proceed however the timing
  // falls.
  //
  // A DENIED CLAIM IS NOT A FAILURE. It means this logical send is already
  // accounted for, so it comes back as `duplicate`, non-retryable, and
  // sendResultToAttempt treats it as ok. Reporting it as a failure would send
  // the step into backoff and, on the recovery path, retry with a FRESH key
  // (`stepId:attemptCount`), which would send the very email this claim exists
  // to prevent.
  const claimed = await claimSend(db, { job, recipientHash, queueMessageId, now });
  if (!claimed) {
    return { status: "duplicate", providerMessageId: null, error: null, retryable: false };
  }

  try {
    const { providerMessageId } = await sendEmail(env, job);
    await flipClaimToSent(db, job.idempotencyKey, providerMessageId, now);
    return { status: "sent", providerMessageId, error: null, retryable: false };
  } catch (err) {
    const error = redactSecrets(err instanceof Error ? err.message : "send failed", job.redact);
    // THE ROW STAYS `pending`, WITH THE ERROR ON IT. Not flipped to `failed`,
    // and the difference is the whole point: `failed` would assert that no mail
    // left, and this code cannot know that. A provider that throws after
    // accepting the message looks identical from here to one that refused it.
    // `pending` plus an error is the honest record of an unknown outcome, and it
    // keeps the claim standing so a retry cannot gamble on the answer.
    await recordClaimError(db, job.idempotencyKey, error);
    return { status: "failed", providerMessageId: null, error, retryable: true };
  }
}

/**
 * Take the claim for one logical send, or discover that somebody already has.
 *
 * Returns true when THIS call inserted the row. False means the unique index
 * refused it, which is the duplicate case and the only error swallowed here: any
 * other failure propagates, so a broken database fails the job CLOSED with no
 * mail sent rather than sending unrecorded mail.
 */
async function claimSend(
  db: Db,
  input: {
    job: OutboundEmailJob;
    recipientHash: string;
    queueMessageId: string | null;
    now: Date;
  },
): Promise<boolean> {
  // FAIL CLOSED ON A MISSING KEY. An empty key would be stored as a real value
  // and collide with every other keyless send, so the claim would start refusing
  // unrelated mail. Every caller passes one; this refuses loudly rather than
  // quietly sending unclaimed.
  if (!input.job.idempotencyKey || !input.job.idempotencyKey.trim()) {
    throw new Error(SEND_CLAIM_MISSING_KEY_ERROR);
  }
  try {
    await buildEmailSendRow(db, {
      job: input.job,
      status: "pending",
      providerMessageId: null,
      error: null,
      recipientHash: input.recipientHash,
      queueMessageId: input.queueMessageId,
      now: input.now,
      idempotencyKey: input.job.idempotencyKey,
    });
    return true;
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err;
    return retakeRefusedClaim(db, input.job.idempotencyKey, input.now);
  }
}

/**
 * A claim already exists for this key. Decide whether this caller may take it
 * over, and the distinction is the whole subtlety of the design.
 *
 * AN OUTCOME NOBODY KNOWS IS NOT A FAILURE. The claim row is written before the
 * provider call, so it exists in two very different situations:
 *
 *   1. `error IS NULL`: the worker never came back. It may have sent the mail
 *      and died before recording it, which is exactly the residual 385 left
 *      open. NOBODY MAY RETRY THIS. Skipping is the only safe answer, because
 *      the alternative is sending a second copy to a real customer.
 *   2. `error IS NOT NULL`: the provider was asked and refused, and we wrote
 *      down what it said. No mail left. A retry is not only safe, it is what
 *      every caller with a stable key already expects.
 *
 * WHY CASE 2 HAS TO EXIST, measured rather than assumed: of the eleven email
 * idempotency-key shapes in this repo, SEVEN are stable across attempts
 * (`expiring-card:alertId`, `winback-step:stepId`, `recovery-notify:paymentId`
 * and others). Only the recovery step's own `stepId:attemptCount` and two
 * siblings vary per try. Under a rule that skipped on any existing row, one
 * transient provider failure would permanently consume those sends, and
 * `expiring-card-cron.test.ts` already has a test named "a send FAILURE leaves
 * the candidate unsent so tomorrow retries" asserting the opposite.
 *
 * THE RE-TAKE IS ONE CONDITIONAL STATEMENT, not a read followed by a write
 * (380): the UPDATE carries `error IS NOT NULL` in its own WHERE and RETURNING
 * says whether this caller won it, so two workers racing on a refused claim
 * cannot both proceed.
 *
 * THE RESIDUAL THIS LEAVES, stated rather than buried: a provider that ACCEPTS
 * the message and then fails to answer is recorded as an error, and the retry
 * will send a second copy. That is the narrow at-least-once case, and it is a
 * strictly smaller window than the one 385 closed, which was every worker death
 * anywhere after the send.
 */
async function retakeRefusedClaim(db: Db, idempotencyKey: string, now: Date): Promise<boolean> {
  const retaken = await db
    .update(emailSends)
    .set({ status: "pending", error: null, createdAt: now })
    .where(and(eq(emailSends.idempotencyKey, idempotencyKey), isNotNull(emailSends.error)))
    .returning({ id: emailSends.id });
  return retaken.length === 1;
}

/** Flip a standing claim to `sent` once the provider has accepted it. */
async function flipClaimToSent(
  db: Db,
  idempotencyKey: string,
  providerMessageId: string | null,
  now: Date,
): Promise<void> {
  await db
    .update(emailSends)
    .set({ status: "sent", providerMessageId, sentAt: now })
    .where(eq(emailSends.idempotencyKey, idempotencyKey));
}

/** Record what the provider said on a claim that stays `pending`. */
async function recordClaimError(db: Db, idempotencyKey: string, error: string): Promise<void> {
  await db.update(emailSends).set({ error }).where(eq(emailSends.idempotencyKey, idempotencyKey));
}

/**
 * Whether this account may send live mail. FAILS CLOSED in all three directions:
 * a row predating the column reads false through the migration's own
 * `DEFAULT false NOT NULL`, a MISSING account reads false, and a job carrying NO
 * account reads false, because a flag that is per-account cannot be satisfied by
 * a job that names none.
 *
 * `EmailJob.accountId` is nullable in the type; measured 2026-08-12, no live
 * caller passes null. processEmailJob has exactly two callers, defaultSend in
 * execute-step.ts (accountId from a non-null EmailStepContext) and the queue
 * consumer, which since 2026-08-14 nothing CAN enqueue to: the producer and its
 * EMAIL_QUEUE binding were deleted under 280, so that caller is unreachable
 * rather than merely unused. So the null branch is unreachable today and exists
 * so it can never become a bypass.
 *
 * SCOPE, stated rather than assumed: this gates processEmailJob, which is the
 * dunning path. `sendTransactionalEmail` and `sendRenderedTransactionalEmail`
 * reach `env.EMAIL` DIRECTLY and are not gated, so verification and
 * password-reset mail is unaffected. 9766ff5 placed
 * the flag in this function specifically, and gating auth mail behind a
 * per-account send switch would lock merchants out of their own accounts.
 */
export async function liveSendsEnabled(db: Db, accountId: string | null): Promise<boolean> {
  if (!accountId) return false;
  const rows = await db
    .select({ enabled: accounts.liveSendsEnabled })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  return rows[0]?.enabled === true;
}

async function logSend(db: Db, input: Parameters<typeof buildEmailSendRow>[1]): Promise<void> {
  try {
    await buildEmailSendRow(db, input);
  } catch {
    // The send log is best-effort; a logging failure must not re-send the email.
  }
}
