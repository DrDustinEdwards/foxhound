import { eq } from "drizzle-orm";

import type { Db } from "~/db";
import { accounts, getDb, emailSends } from "~/db";

import { sendEmail } from "./send";
import { isSuppressed } from "./suppression";
import type { EmailJob } from "./types";

// Email dispatch: suppression gate -> send -> email_sends log.
//
// Corrected 2026-08-11. This header used to describe "producer (enqueue onto
// the Queue) + consumer orchestration" as though the queue were the live path.
// It is not, and measurement says so: enqueueEmail has ZERO call sites in this
// repository, so nothing ever puts a message on foxhound-email. The producer
// binding and the consumer config both exist in wrangler.jsonc, and the queue's
// retry ceiling and dead-letter queue are therefore dead infrastructure today.
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

export type EmailSendStatus = "sent" | "suppressed" | "failed" | "blocked";

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

// BINDING PRE-CONDITION BEFORE THIS IS WIRED. Ratified 2026-08-09.
//
// enqueueEmail currently has ZERO call sites. When it is wired to anything, the
// send gate lands in the SAME commit: a per-account live flag, defaulting OFF,
// checked in processEmailJob. Not a follow-up, not a separate PR.
//
// The reason is that there is no send-enable flag anywhere in this codebase
// today. Grepped 2026-08-11 for EMAIL_ENABLED, sendEnabled, dryRun, sandbox and
// the rest: nothing email-related exists. What actually stops mail leaving is
// an unset PHYSICAL_ADDRESS secret, which makes buildEmailMessage throw
// "email blocked: missing CAN-SPAM physical address" at app/lib/email/send.ts:33-38.
//
// That is a compliance guard doing duty as a kill switch. It is undocumented as
// a switch, nobody chose it as one, and it is a single populated env var away
// from every eligible account receiving live mail. Accounts are eligible by
// default (processing_paused defaults false) and the recovery cron is enabled
// by default when its config row is absent, so the blast radius on the day that
// var gets set is every eligible account at once.
//
// The same pre-condition is repeated at processEmailJob, which is the live path.
// Wiring this producer does not satisfy it; the flag has to be checked where the
// send actually happens.

/** Enqueue an email job. Producer seam; throws if the queue is not configured. */
export async function enqueueEmail(env: Env, job: EmailJob): Promise<void> {
  if (!env.EMAIL_QUEUE) {
    throw new Error("EMAIL_QUEUE binding is not configured");
  }
  await env.EMAIL_QUEUE.send(job);
}

/** SHA-256 hex of a recipient address; email_sends stores this, never the raw address. */
export async function hashRecipient(email: string): Promise<string> {
  const data = new TextEncoder().encode(email.trim().toLowerCase());
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The email_sends log row for a completed job. Pure; compile-tested. */
export function buildEmailSendRow(
  db: Db,
  input: {
    job: EmailJob;
    status: EmailSendStatus;
    providerMessageId: string | null;
    error: string | null;
    recipientHash: string;
    queueMessageId: string | null;
    now: Date;
  },
) {
  return db.insert(emailSends).values({
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
    createdAt: input.now,
  });
}

// THE BINDING PRE-CONDITION IS NOW SATISFIED. Ratified 2026-08-09, rescoped
// 2026-08-11 after measuring which path is live, and BUILT here by S7 Phase 2
// Session D under ruling 268.
//
// What it asked for: a per-account live flag, defaulting OFF, checked in THIS
// function before sendEmail. processEmailJob is the live path (the recovery cron
// calls it synchronously via defaultSend); enqueueEmail is on no path at all, so
// gating the producer would have gated nothing.
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
  job: EmailJob,
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
  if (!(await liveSendsEnabled(db, job.accountId))) {
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

  try {
    const { providerMessageId } = await sendEmail(env, job);
    await logSend(db, {
      job,
      status: "sent",
      providerMessageId,
      error: null,
      recipientHash,
      queueMessageId,
      now,
    });
    return { status: "sent", providerMessageId, error: null, retryable: false };
  } catch (err) {
    const error = err instanceof Error ? err.message : "send failed";
    await logSend(db, {
      job,
      status: "failed",
      providerMessageId: null,
      error,
      recipientHash,
      queueMessageId,
      now,
    });
    return { status: "failed", providerMessageId: null, error, retryable: true };
  }
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
 * consumer (which nothing enqueues to). So the null branch is unreachable today
 * and exists so it can never become a bypass.
 *
 * SCOPE, stated rather than assumed: this gates processEmailJob, which is the
 * dunning path. `sendTransactionalEmail` reaches `env.EMAIL` DIRECTLY and is not
 * gated, so verification and password-reset mail is unaffected. 9766ff5 placed
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
