import { eq } from "drizzle-orm";
import type { Db } from "~/db";
import { accounts, stripeConnections } from "~/db/schema";
import { activePrimaryConnectionWhere } from "~/lib/stripe/connections.server";
import { isValidReplyToEmail } from "~/lib/settings/reply-to";

/** ADMIN_EMAIL_TEST_RECIPIENTS, lower-cased, separated by commas or spaces. */
export function testRecipientAllowList(env: Env): string[] {
  return (env.ADMIN_EMAIL_TEST_RECIPIENTS ?? "")
    .split(/[\s,]+/)
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean);
}

export type Recipient =
  | { ok: true; to: string; kind: "self" | "allow_list" }
  | { ok: false; error: string };

/**
 * Who a test mail goes to. Omitted, the acting admin. Given, it must be one
 * address and either the acting admin's own or on the allow list; anything else
 * is refused, another admin's address included, because each admin chooses
 * their own inbox.
 */
export function resolveTestRecipient(env: Env, actorEmail: string, requested: unknown): Recipient {
  const actor = actorEmail.trim().toLowerCase();
  if (requested === undefined || requested === null) return { ok: true, to: actor, kind: "self" };
  const refusal = {
    ok: false as const,
    error:
      "Test mail goes only to your own address or to an address on ADMIN_EMAIL_TEST_RECIPIENTS. Omit to to send to yourself, or ask Dustin to add the inbox to that list.",
  };
  if (typeof requested !== "string") return refusal;
  const to = requested.trim().toLowerCase();
  if (!isValidReplyToEmail(to)) return refusal;
  if (to === actor) return { ok: true, to, kind: "self" };
  if (testRecipientAllowList(env).includes(to)) return { ok: true, to, kind: "allow_list" };
  return refusal;
}

export interface MerchantEmailSettings {
  accountId: string;
  name: string | null;
  senderName: string | null;
  replyTo: string | null;
  brandVoice: {
    default: string | null;
    soft: string | null;
    expired: string | null;
    network: string | null;
    fraud: string | null;
  };
}

/**
 * The account and its primary live connection's sender settings, or null for an
 * unknown account. Reads no customer data.
 */
export async function loadMerchantEmailSettings(
  db: Db,
  accountId: string,
): Promise<MerchantEmailSettings | null> {
  const [account] = await db
    .select({ id: accounts.id, name: accounts.name })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  if (!account) return null;
  const [connection] = await db
    .select({
      senderName: stripeConnections.senderName,
      replyTo: stripeConnections.replyToEmail,
      brandVoice: stripeConnections.brandVoice,
      soft: stripeConnections.brandVoiceSoft,
      expired: stripeConnections.brandVoiceExpired,
      network: stripeConnections.brandVoiceNetwork,
      fraud: stripeConnections.brandVoiceFraud,
    })
    .from(stripeConnections)
    .where(activePrimaryConnectionWhere(accountId))
    .limit(1);
  return {
    accountId: account.id,
    name: account.name ?? null,
    senderName: connection?.senderName ?? null,
    replyTo: connection?.replyTo ?? null,
    brandVoice: {
      default: connection?.brandVoice ?? null,
      soft: connection?.soft ?? null,
      expired: connection?.expired ?? null,
      network: connection?.network ?? null,
      fraud: connection?.fraud ?? null,
    },
  };
}
