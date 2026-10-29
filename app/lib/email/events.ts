import { eq } from "drizzle-orm";

import type { Db } from "~/db";
import { getDb, emailSends, emailSuppressions } from "~/db";

// Bounce/complaint handling. Email Service delivery events are consumed off a
// Queue; hard bounces and spam complaints add the recipient to email_suppressions
// so the suppression gate (send.ts path) never sends to them again. Idempotent by
// construction: one suppression per address is enforced by the unique index
// email_suppressions_email_uq (migration 0003), so a redelivered bounce event
// collapses via onConflictDoNothing rather than a read-then-write race.
//
// ATTRIBUTION (parity gap 9). Recova attributed every deliverability event to
// its merchant by the provider's message id: Resend's `data.email_id` looked up
// recovery_steps.resend_message_id and took that row's account_id
// (recova app/api/webhooks/resend/route.ts, "R-13: read account_id straight off
// recovery_steps"). Foxhound's equivalent of that row is email_sends, which
// records the Email Service message id as provider_message_id, so an event's
// `payload.messageId` resolves to the send and its account_id. An event whose
// message id matches no send keeps account_id null, as before.

export interface EmailServiceEvent {
  /** Event kind (bounce, hard_bounce, soft_bounce, complaint, delivered, ...). */
  type: string;
  email: string;
  /** Provider event id, stored as the suppression token for traceability. */
  eventId: string;
  /** Email Service message id of the send this event is about, when known. */
  messageId?: string | null;
  reason?: string | null;
  accountId?: string | null;
}

/** The Email Sending event-subscription envelope as Queues delivers it
 *  (developers.cloudflare.com/email-service/reference/event-subscriptions/). */
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

/** A queue body as an EmailServiceEvent. Accepts the Email Sending envelope
 *  (`cf.email.sending.message.*` with a `payload`) and the flat shape this
 *  module has always taken. A bounced envelope is a hard bounce unless its
 *  bounce type says soft, which is Recova's rule (hard, Permanent or absent
 *  counts as hard). Pure. */
export function normalizeEmailEvent(body: unknown): EmailServiceEvent {
  const raw = (body ?? {}) as EmailSendingEnvelope & Partial<EmailServiceEvent>;
  if (typeof raw.type === "string" && raw.type.startsWith(ENVELOPE_PREFIX) && raw.payload) {
    const p = raw.payload;
    const kind = raw.type.slice(ENVELOPE_PREFIX.length);
    const type =
      kind === "bounced" ? (p.bounce?.type === "soft" ? "soft_bounce" : "hard_bounce")
      : kind === "complained" ? "complaint"
      : kind;
    return {
      type,
      email: p.recipient ?? "",
      eventId: p.eventId ?? "",
      messageId: p.messageId ?? null,
      reason: p.bounce?.reason ?? null,
    };
  }
  return {
    type: raw.type ?? "",
    email: raw.email ?? "",
    eventId: raw.eventId ?? "",
    messageId: raw.messageId ?? null,
    reason: raw.reason ?? null,
    accountId: raw.accountId ?? null,
  };
}

const SUPPRESSING_TYPES = new Set(["bounce", "hard_bounce", "complaint", "spam"]);

/** True for event types that should suppress the recipient. Pure. */
export function shouldSuppress(event: EmailServiceEvent): boolean {
  return SUPPRESSING_TYPES.has(event.type) && !!event.email;
}

/** The account an event belongs to: the one it already names, else the
 *  account of the email_sends row carrying its message id, else null. */
export async function resolveEventAccountId(db: Db, event: EmailServiceEvent): Promise<string | null> {
  if (event.accountId) return event.accountId;
  if (!event.messageId) return null;
  const [send] = await db
    .select({ accountId: emailSends.accountId })
    .from(emailSends)
    .where(eq(emailSends.providerMessageId, event.messageId))
    .limit(1);
  return send?.accountId ?? null;
}

/** The email_suppressions insert for a suppressing event. Structurally idempotent:
 *  a duplicate address is a no-op via the unique index (email_suppressions_email_uq). */
export function buildSuppressionInsert(
  db: Db,
  input: { email: string; token: string; reason: string; accountId: string | null; now: Date },
) {
  return db
    .insert(emailSuppressions)
    .values({
      email: input.email,
      token: input.token,
      reason: input.reason,
      accountId: input.accountId,
      suppressedAt: input.now,
    })
    .onConflictDoNothing({ target: emailSuppressions.email });
}

/** Record one queue body as a suppression, attributed to its send's account. */
export async function recordEmailEvent(
  db: Db,
  body: unknown,
  now: Date,
): Promise<"suppressed" | "ignored"> {
  const event = normalizeEmailEvent(body);
  if (!shouldSuppress(event)) return "ignored";
  await buildSuppressionInsert(db, {
    email: event.email,
    token: event.eventId,
    reason: event.type,
    accountId: await resolveEventAccountId(db, event),
    now,
  });
  return "suppressed";
}

/** Process one Email Service event into a suppression, idempotently. */
export async function processEmailEvent(
  env: Env,
  body: unknown,
): Promise<"suppressed" | "ignored"> {
  return recordEmailEvent(getDb(env), body, new Date());
}
