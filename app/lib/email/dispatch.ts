import type { Db } from "~/db";
import { getDb, emailSends } from "~/db";

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

export type EmailSendStatus = "sent" | "suppressed" | "failed";

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

// BINDING PRE-CONDITION, AND THIS IS THE SITE THAT MATTERS. Ratified 2026-08-09,
// rescoped here 2026-08-11 after measuring which path is live.
//
// A per-account live flag, defaulting OFF, is required BEFORE live sends, and it
// belongs in this function. processEmailJob is on the live path (the recovery
// cron calls it synchronously via defaultSend); enqueueEmail is not on any path
// at all. Gating only the producer would gate nothing.
//
// There is no such flag today. The de facto kill switch is an unset
// PHYSICAL_ADDRESS secret, which throws in buildEmailMessage at
// app/lib/email/send.ts:33-38 before the EMAIL binding is reached. That is a
// CAN-SPAM compliance guard, not a feature flag: it was never chosen as a
// switch, it is not documented as one, and setting that one env var turns on
// live mail for every eligible account simultaneously. Eligibility defaults to
// on (processing_paused defaults false, cancelled_at null) and the recovery
// cron is enabled when its config row is absent.
//
// The flag goes here, checked before sendEmail, in the same commit as whatever
// first makes live sends reachable.

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

async function logSend(db: Db, input: Parameters<typeof buildEmailSendRow>[1]): Promise<void> {
  try {
    await buildEmailSendRow(db, input);
  } catch {
    // The send log is best-effort; a logging failure must not re-send the email.
  }
}
