import type { Db } from "~/db/client";
import { emailDeadLetters } from "~/db/schema";
import { alertDeadLetters } from "~/lib/cron/alerts.server";

import { hashRecipient } from "./dispatch";
import type { EmailJob } from "./types";

/** The dead-letter trace: a row a human can query for an email that exhausted its retries. One step only:
 *  write the row, alert once per day; retry-from-DLQ is not built. Stores a recipient HASH, never the address. */

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

async function buildDeadLetterRecord(
  job: EmailJob,
  input: {
    queueMessageId: string | null;
    attempts: number | null;
    error: string | null;
    now: Date;
  },
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

/** Persist a batch of dead letters and raise one alert. A single bad message never throws past itself, so
 *  one unparseable payload cannot discard the rest; failures are counted and reported. */
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

  // One alert per day for the whole class.
  const alert = await alertDeadLetters(env, { written, failed }, now);

  return { written, failed, alerted: alert.sent };
}
