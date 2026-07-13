import { eq } from "drizzle-orm";

import type { Db } from "~/db";
import { getDb, emailSuppressions } from "~/db";

// Bounce/complaint handling. Email Service delivery events are consumed off a
// Queue; hard bounces and spam complaints add the recipient to email_suppressions
// so the suppression gate (send.ts path) never sends to them again. Idempotent:
// one suppression per address (read-guarded, since email_suppressions has no
// unique index yet; a unique index on email would make this structural, flagged
// for a schema follow-up).

export interface EmailServiceEvent {
  /** Event kind from Email Service (bounce, complaint, delivered, ...). */
  type: string;
  email: string;
  /** Provider event id, stored as the suppression token for traceability. */
  eventId: string;
  reason?: string | null;
  accountId?: string | null;
}

const SUPPRESSING_TYPES = new Set(["bounce", "hard_bounce", "complaint", "spam"]);

/** True for event types that should suppress the recipient. Pure. */
export function shouldSuppress(event: EmailServiceEvent): boolean {
  return SUPPRESSING_TYPES.has(event.type) && !!event.email;
}

/** The email_suppressions insert for a suppressing event. */
export function buildSuppressionInsert(
  db: Db,
  input: { email: string; token: string; reason: string; accountId: string | null; now: Date },
) {
  return db.insert(emailSuppressions).values({
    email: input.email,
    token: input.token,
    reason: input.reason,
    accountId: input.accountId,
    suppressedAt: input.now,
  });
}

/** Process one Email Service event into a suppression, idempotently. */
export async function processEmailEvent(
  env: Env,
  event: EmailServiceEvent,
): Promise<"suppressed" | "ignored"> {
  if (!shouldSuppress(event)) return "ignored";
  const db = getDb(env);
  const existing = await db
    .select({ id: emailSuppressions.id })
    .from(emailSuppressions)
    .where(eq(emailSuppressions.email, event.email))
    .limit(1);
  if (existing.length > 0) return "ignored";
  await buildSuppressionInsert(db, {
    email: event.email,
    token: event.eventId,
    reason: event.type,
    accountId: event.accountId ?? null,
    now: new Date(),
  });
  return "suppressed";
}
