import { and, eq } from "drizzle-orm";
import type { Db } from "~/db";
import { stripeConnections } from "~/db";
import { readVoiceSamples, storeVoiceSamples } from "~/lib/recovery/voice-samples";

import {
  buildBrandVoiceUpdate,
  buildVoiceSamplesUpdate,
  buildCategoryVoicesUpdate,
  buildSenderSettingsUpdate,
} from "./persist.server";
import { isValidReplyToEmail, REPLY_TO_EMAIL_MAX_LENGTH } from "./reply-to";
import { SENDER_NAME_MAX_LENGTH } from "./sender-name";
import { asOptionalText, asVoice } from "./setting-input";
import { type ApplyResult, type WriteTrace, commit } from "./apply.server";

export interface SenderNameState {
  connectionId: string;
  senderName: string | null;
  /** Present only when the caller sent the field. */
  replyToEmail?: string | null;
}

/**
 * The sender name on one connection. TWO REFUSALS, both the form's own strings: no connection, and
 * over the bound. The bound is 80.
 */
export async function applySenderName(
  db: Db,
  accountId: string,
  input: { connectionId: unknown; senderName: unknown; replyToEmail?: unknown },
  trace?: WriteTrace,
): Promise<ApplyResult<SenderNameState>> {
  const connectionId = typeof input.connectionId === "string" ? input.connectionId.trim() : "";
  if (!connectionId) {
    return { ok: false, error: "Connect Stripe before setting a sender name." };
  }

  const senderName = asOptionalText(input.senderName);
  if (senderName && senderName.length > SENDER_NAME_MAX_LENGTH) {
    return {
      ok: false,
      error: `Sender name must be ${SENDER_NAME_MAX_LENGTH} characters or fewer.`,
    };
  }

  const writesReplyTo = input.replyToEmail !== undefined;
  const replyToEmail = writesReplyTo ? asOptionalText(input.replyToEmail) : undefined;
  if (replyToEmail && replyToEmail.length > REPLY_TO_EMAIL_MAX_LENGTH) {
    return {
      ok: false,
      error: `Reply-to email must be ${REPLY_TO_EMAIL_MAX_LENGTH} characters or fewer.`,
    };
  }
  if (replyToEmail && !isValidReplyToEmail(replyToEmail)) {
    return { ok: false, error: "Enter a valid reply-to email address." };
  }

  const owned = await db
    .select({ id: stripeConnections.id })
    .from(stripeConnections)
    .where(and(eq(stripeConnections.id, connectionId), eq(stripeConnections.accountId, accountId)))
    .limit(1);
  if (owned.length === 0) {
    return { ok: false, error: "Connect Stripe before setting a sender name." };
  }

  const fields = writesReplyTo ? ["sender_name", "reply_to_email"] : ["sender_name"];
  await commit(
    db,
    accountId,
    fields,
    buildSenderSettingsUpdate(db, accountId, connectionId, { senderName, replyToEmail }),
    trace,
  );
  const state: SenderNameState = { connectionId, senderName };
  if (writesReplyTo) state.replyToEmail = replyToEmail ?? null;
  return { ok: true, fields, state };
}

export interface BrandVoiceState {
  connectionId: string;
  general: string | null;
  soft: string | null;
  expired: string | null;
  network: string | null;
  fraud: string | null;
  /** The merchant's own past emails, as they will be read back. */
  samples: string[];
}

/** The five voice columns, keyed the way callers name them and valued the way
 *  the trace records them. Naming each one IS the allowlist. */
const BRAND_VOICE_COLUMNS = {
  general: "brand_voice",
  soft: "brand_voice_soft",
  expired: "brand_voice_expired",
  network: "brand_voice_network",
  fraud: "brand_voice_fraud",
} as const;

type BrandVoiceKey = keyof typeof BRAND_VOICE_COLUMNS;

/** One sentence for both refusals, and it is the form's own. */
const NO_CONNECTION_FOR_VOICE = "Connect Stripe before setting a brand voice.";

/**
 * The general voice plus the four decline-category voices, on one connection. ABSENT MEANS LEAVE
 * ALONE; EMPTY MEANS CLEAR. A TOOL caller can omit a key, and omission must not wipe four
 * categories the merchant set in the UI. It only decides which columns are in the SET.
 */
export async function applyBrandVoice(
  db: Db,
  accountId: string,
  input: {
    connectionId: unknown;
    general?: unknown;
    soft?: unknown;
    expired?: unknown;
    network?: unknown;
    fraud?: unknown;
    /** The pasted past emails, one string per box. Absent leaves them alone;
     *  a list of empty boxes clears them. */
    samples?: unknown;
  },
  trace?: WriteTrace,
): Promise<ApplyResult<BrandVoiceState>> {
  const connectionId = typeof input.connectionId === "string" ? input.connectionId.trim() : "";
  if (!connectionId) return { ok: false, error: NO_CONNECTION_FOR_VOICE };

  // The ownership check and the read of the current voices are ONE query: the
  // fallback below needs the stored values, and a separate existence check
  // would be a second round trip for the same row.
  const found = await db
    .select({
      general: stripeConnections.brandVoice,
      soft: stripeConnections.brandVoiceSoft,
      expired: stripeConnections.brandVoiceExpired,
      network: stripeConnections.brandVoiceNetwork,
      fraud: stripeConnections.brandVoiceFraud,
      samples: stripeConnections.brandVoiceSamples,
    })
    .from(stripeConnections)
    .where(and(eq(stripeConnections.id, connectionId), eq(stripeConnections.accountId, accountId)))
    .limit(1);
  if (found.length === 0) return { ok: false, error: NO_CONNECTION_FOR_VOICE };
  const stored = found[0];

  const fields: string[] = [];
  let tooLong: string | null = null;
  const resolve = (key: BrandVoiceKey): string | null => {
    const supplied = input[key];
    if (supplied === undefined) return stored[key];
    fields.push(BRAND_VOICE_COLUMNS[key]);
    const text = asVoice(supplied);
    if (!text.ok) tooLong = text.error;
    return text.ok ? text.value : null;
  };

  const state: BrandVoiceState = {
    connectionId,
    general: resolve("general"),
    soft: resolve("soft"),
    expired: resolve("expired"),
    network: resolve("network"),
    fraud: resolve("fraud"),
    samples: readVoiceSamples(stored.samples),
  };
  if (tooLong) return { ok: false, error: tooLong };
  let storedSamples = stored.samples;
  if (input.samples !== undefined) {
    if (!Array.isArray(input.samples))
      return { ok: false, error: "Sample emails must be a list of texts." };
    fields.push("brand_voice_samples");
    storedSamples = storeVoiceSamples(input.samples);
    state.samples = readVoiceSamples(storedSamples);
  }

  await commit(
    db,
    accountId,
    fields,
    [
      buildCategoryVoicesUpdate(db, accountId, connectionId, {
        soft: state.soft,
        expired: state.expired,
        network: state.network,
        fraud: state.fraud,
      }),
      buildBrandVoiceUpdate(db, accountId, connectionId, state.general),
      buildVoiceSamplesUpdate(db, accountId, connectionId, storedSamples),
    ],
    trace,
  );
  return { ok: true, fields, state };
}
