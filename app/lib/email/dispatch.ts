import type { Db } from "~/db";
import { getDb, emailSends } from "~/db";

import { sendEmail } from "./send";
import { isSuppressed } from "./suppression";
import type { EmailJob } from "./types";

// Email dispatch: producer (enqueue onto the Queue) + consumer orchestration
// (suppression gate -> send -> email_sends log). The Queue provides retries +
// dead-letter (wrangler consumer config). The consumer's decision logic is pure
// and unit-tested; the enqueue + send are seams finalized when the queue + Email
// Service bindings are live (Phase 8).

export type EmailSendStatus = "sent" | "suppressed" | "failed";

export interface EmailJobResult {
  status: EmailSendStatus;
  providerMessageId: string | null;
  error: string | null;
  /** True when the queue message should be retried (transient send failure). */
  retryable: boolean;
}

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

/**
 * Process one queued email job: suppression gate, then send, then log. A
 * suppressed recipient is a terminal success (logged, no send, no retry). A send
 * failure is retryable (the queue redelivers up to its retry ceiling, then
 * dead-letters). Returns the result so the consumer can ack vs retry.
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
