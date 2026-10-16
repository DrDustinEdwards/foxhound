import {
  auditAccountForMonth,
  enqueueMonthlyAudits,
  parseMonthlyAuditMessage,
} from "~/lib/audit/monthly.server";

// The monthly audit as two halves (job_97878f0d1fde): the cron enqueues one
// message per opted-in account and the queue consumer audits one account per
// message. This helper runs both halves in order against an in-memory queue and
// totals the per-account outcomes, so a suite about WHAT the audit does to one
// account can keep asking it in one call. The queue wiring itself (the
// registered cron, handleQueueBatch, ack and retry) is proven in
// test/audit-monthly-queue-apa.test.ts.

export interface DrivenMonthlyAudit {
  eligible: number;
  optedIn: number;
  ran: number;
  sent: number;
  skippedDuplicate: number;
  skippedNotEligible: number;
  skippedNoConnection: number;
  skippedNoRecipient: number;
  /** E24's refused sends: a suppressed address, live sends off, a standing claim. */
  suppressed: number;
  blocked: number;
  alreadySent: number;
  failed: number;
  /** The thrown values of failed accounts, whole. */
  errors: unknown[];
}

export async function driveMonthlyAudit(
  env: Env,
  now: Date,
  cronRunId: string | null,
): Promise<DrivenMonthlyAudit> {
  const bodies: unknown[] = [];
  const queued = {
    ...env,
    AUDIT_QUEUE: {
      send: async (body: unknown) => {
        bodies.push(body);
      },
      sendBatch: async (messages: { body: unknown }[]) => {
        for (const m of messages) bodies.push(m.body);
      },
    },
  } as unknown as Env;

  const enqueued = await enqueueMonthlyAudits(queued, now, cronRunId);
  const result: DrivenMonthlyAudit = {
    eligible: enqueued.eligible,
    optedIn: enqueued.optedIn,
    ran: 0,
    sent: 0,
    skippedDuplicate: 0,
    skippedNotEligible: 0,
    skippedNoConnection: 0,
    skippedNoRecipient: 0,
    suppressed: 0,
    blocked: 0,
    alreadySent: 0,
    failed: 0,
    errors: [],
  };

  for (const body of bodies) {
    const message = parseMonthlyAuditMessage(body);
    if (!message) throw new Error("the producer wrote a message its own parser refuses");
    const outcome = await auditAccountForMonth(queued, message, now);
    if (outcome.ran) result.ran += 1;
    switch (outcome.status) {
      case "sent":
        result.sent += 1;
        break;
      case "duplicate":
        result.skippedDuplicate += 1;
        break;
      case "not_eligible":
        result.skippedNotEligible += 1;
        break;
      case "no_connection":
        result.skippedNoConnection += 1;
        break;
      case "no_recipient":
        result.skippedNoRecipient += 1;
        break;
      case "suppressed":
        result.suppressed += 1;
        break;
      case "blocked":
        result.blocked += 1;
        break;
      case "already_sent":
        result.alreadySent += 1;
        break;
      case "failed":
        result.failed += 1;
        result.errors.push(outcome.error);
        break;
    }
  }
  return result;
}
