import { eq } from "drizzle-orm";

import type { Db } from "~/db";
import { getDb, emailSends, emailSuppressions } from "~/db";

// Bounce/complaint handling: hard bounces and spam complaints add the recipient to email_suppressions so
// the gate never sends to them again. Idempotent via the unique index email_suppressions_email_uq
// (a redelivered event collapses by onConflictDoNothing). An event is attributed to its merchant by
// `payload.messageId` -> email_sends.provider_message_id -> account_id; no match keeps account_id null.

export interface EmailServiceEvent {
  type: string;
  email: string;
  eventId: string;
  messageId?: string | null;
  reason?: string | null;
  accountId?: string | null;
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

/** A queue body as an EmailServiceEvent: the Email Sending envelope or the flat shape. A bounce is hard
 *  unless its bounce type says soft. Pure. */
function normalizeEmailEvent(body: unknown): EmailServiceEvent {
  const raw = (body ?? {}) as EmailSendingEnvelope & Partial<EmailServiceEvent>;
  if (typeof raw.type === "string" && raw.type.startsWith(ENVELOPE_PREFIX) && raw.payload) {
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

export function shouldSuppress(event: EmailServiceEvent): boolean {
  return SUPPRESSING_TYPES.has(event.type) && !!event.email;
}

async function resolveEventAccountId(db: Db, event: EmailServiceEvent): Promise<string | null> {
  if (event.accountId) return event.accountId;
  if (!event.messageId) return null;
  const [send] = await db
    .select({ accountId: emailSends.accountId })
    .from(emailSends)
    .where(eq(emailSends.providerMessageId, event.messageId))
    .limit(1);
  return send?.accountId ?? null;
}

/** The suppression insert for a suppressing event; a duplicate address is a no-op via the unique index. */
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

export async function processEmailEvent(
  env: Env,
  body: unknown,
): Promise<"suppressed" | "ignored"> {
  return recordEmailEvent(getDb(env), body, new Date());
}
