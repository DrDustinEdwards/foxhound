import type { Db } from "~/db/client";
import { emailDeadLetters } from "~/db/schema";
import { alertDeadLetters } from "~/lib/cron/alerts.server";

import { hashRecipient } from "./dispatch";
import type { EmailJob } from "./types";

/** The dead-letter trace (313, escalated by 312: discard-with-no-trace dies).
 *
 *  BEFORE THIS: wrangler.jsonc declared `dead_letter_queue: "foxhound-email-dlq"`
 *  as a bare queue NAME with no consumer. Measured at 313: the queue exists
 *  (created 2026-07-25) and had ZERO consumers, so the config's own comment was
 *  exactly right, "a dunning email that keeps failing is discarded with no trace
 *  after max_retries". This is the trace.
 *
 *  SCOPE IS DELIBERATELY ONE STEP: write the row, alert once per day. Retry-from-
 *  DLQ is NOT built here and is not implied by this table. A row a human can query
 *  is the cheapest honest fix, and 313 ranked it first for that reason: knowing a
 *  send died beats a sophisticated recovery for a failure nobody can currently
 *  see.
 *
 *  PRIVACY: stores a recipient HASH, never the address, matching email_sends. A
 *  dead letter is a diagnostic, not a mailbox. */

interface DeadLetterRecord {
  id: string;
  accountId: string | null;
  recoveryStepId: string | null;
  winBackStepId: string | null;
  queueMessageId: string | null;
  template: string | null;
  recipientHash: string | null;
  attempts: number | null;
  error: string | null;
  createdAt: Date;
}

/** Build the row for one dead-lettered job. Pure apart from the hash, so the
 *  shape is assertable without a queue or a database. */
async function buildDeadLetterRecord(
  job: EmailJob,
  input: { queueMessageId: string | null; attempts: number | null; error: string | null; now: Date },
): Promise<DeadLetterRecord> {
  return {
    id: crypto.randomUUID(),
    accountId: job.accountId ?? null,
    recoveryStepId: job.recoveryStepId ?? null,
    winBackStepId: job.winBackStepId ?? null,
    queueMessageId: input.queueMessageId,
    template: job.template ?? null,
    recipientHash: job.to ? await hashRecipient(job.to) : null,
    attempts: input.attempts,
    error: input.error,
    createdAt: input.now,
  };
}

export interface DeadLetterBatchResult {
  written: number;
  failed: number;
  alerted: boolean;
}

/** Persist a batch of dead letters and raise ONE alert for the batch.
 *
 *  NEVER THROWS PAST ITSELF on a single bad message: one unparseable payload must
 *  not discard the rest of the batch, which would reproduce the very
 *  silent-discard this table exists to end. Failures are counted and reported. */
export async function recordDeadLetters(
  env: Env,
  db: Db,
  messages: { id: string; attempts: number; body: unknown }[],
  now: Date,
): Promise<DeadLetterBatchResult> {
  let written = 0;
  let failed = 0;

  for (const message of messages) {
    try {
      const job = message.body as EmailJob;
      const record = await buildDeadLetterRecord(job, {
        queueMessageId: message.id,
        attempts: message.attempts,
        error: "exhausted queue retries",
        now,
      });
      await db.insert(emailDeadLetters).values(record);
      written += 1;
    } catch {
      failed += 1;
    }
  }

  // One alert per day for the whole class, deduped by the same mechanism the
  // cron alerts use. A burst of dead letters is one problem, not N.
  const alert = await alertDeadLetters(env, db, { written, failed }, now);

  return { written, failed, alerted: alert.sent };
}
