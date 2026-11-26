import { eq, isNull } from "drizzle-orm";

import type { Db } from "~/db";
import { emailSends, emailSuppressions } from "~/db";

// Bounce/complaint handling: hard bounces and spam complaints add the recipient to email_suppressions so
// the gate never sends to them again. Idempotent via the unique index email_suppressions_email_uq
// (a redelivered event collapses by onConflictDoNothing). An event is attributed to its merchant by
// `payload.messageId` -> email_sends.provider_message_id -> account_id; no match keeps account_id null.

export interface EmailServiceEvent {
  type: string;
  email: string;
  eventId: string;
  messageId: string | null;
  reason: string | null;
}

interface EmailSendingEnvelope {
  type?: string;
  payload?: {
    eventId?: string;
    messageId?: string;
    recipient?: string;
    bounce?: { type?: string; reason?: string };
  };
}

const ENVELOPE_PREFIX = "cf.email.sending.message.";

/** A queue body (the Email Sending envelope) as an EmailServiceEvent, or null for anything else. A bounce is hard
 *  unless its bounce type says soft. Pure. */
function normalizeEmailEvent(body: unknown): EmailServiceEvent | null {
  const raw = (body ?? {}) as EmailSendingEnvelope;
  if (typeof raw.type !== "string" || !raw.type.startsWith(ENVELOPE_PREFIX) || !raw.payload) {
    return null;
  }
  const p = raw.payload;
  const kind = raw.type.slice(ENVELOPE_PREFIX.length);
  const type =
    kind === "bounced"
      ? p.bounce?.type === "soft"
        ? "soft_bounce"
        : "hard_bounce"
      : kind === "complained"
        ? "complaint"
        : kind;
  return {
    type,
    email: p.recipient ?? "",
    eventId: p.eventId ?? "",
    messageId: p.messageId ?? null,
    reason: p.bounce?.reason ?? null,
  };
}

/** The suppression reasons written: a hard bounce and a spam complaint. The deliverability panel counts by them. */
export const SUPPRESSION_REASON = { bounce: "hard_bounce", complaint: "complaint" } as const;
const SUPPRESSING_TYPES = new Set<string>(Object.values(SUPPRESSION_REASON));

export function shouldSuppress(event: EmailServiceEvent): boolean {
  return SUPPRESSING_TYPES.has(event.type) && !!event.email;
}

async function resolveEventAccountId(db: Db, event: EmailServiceEvent): Promise<string | null> {
  if (!event.messageId) return null;
  const [send] = await db
    .select({ accountId: emailSends.accountId })
    .from(emailSends)
    .where(eq(emailSends.providerMessageId, event.messageId))
    .limit(1);
  return send?.accountId ?? null;
}

/**
 * The suppression insert for a suppressing event, the address stored lowercase. A duplicate address is a
 * no-op via the unique index, except a migrated row with suppressed_at NULL, which this suppresses.
 */
export function buildSuppressionInsert(
  db: Db,
  input: { email: string; token: string; reason: string; accountId: string | null; now: Date },
) {
  return db
    .insert(emailSuppressions)
    .values({
      email: input.email.toLowerCase(),
      token: input.token,
      reason: input.reason,
      accountId: input.accountId,
      suppressedAt: input.now,
    })
    .onConflictDoUpdate({
      target: emailSuppressions.email,
      set: {
        suppressedAt: input.now,
        reason: input.reason,
        token: input.token,
        accountId: input.accountId,
      },
      setWhere: isNull(emailSuppressions.suppressedAt),
    });
}

export async function recordEmailEvent(
  db: Db,
  body: unknown,
  now: Date,
): Promise<"suppressed" | "ignored"> {
  const event = normalizeEmailEvent(body);
  if (!event || !shouldSuppress(event)) return "ignored";
  await buildSuppressionInsert(db, {
    email: event.email,
    token: event.eventId,
    reason: event.type,
    accountId: await resolveEventAccountId(db, event),
    now,
  });
  return "suppressed";
}
