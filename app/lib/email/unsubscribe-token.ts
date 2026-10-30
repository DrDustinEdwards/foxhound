import { readSignedToken, signToken } from "@dustinedwards/site-runtime/signed-token";
import { linkKeys } from "~/lib/http/signed-token";

// Stateless HMAC-signed token for the CAN-SPAM one-click unsubscribe link
// (/u/:token, ROUTES.md public-utility). Mirrors the engagement/card-update
// token pattern (HMAC for integrity, not secrecy; the payload carries only the
// recipient address + account, no other PII), keyed on ENCRYPTION_KEY. Unlike a
// card-update token this one does NOT expire: an unsubscribe link must keep
// working indefinitely so a recipient can always opt out.

export interface UnsubscribeTokenPayload {
  /** Recipient address to suppress when the link is followed. */
  email: string;
  /** The account whose send this was (for scoping the suppression record). */
  accountId: string;
  /**
   * Which list the link leaves. Absent: the address-wide unsubscribe every
   * customer mail carries. "digest": the weekly digest only (E23), which
   * switches off that account's digest and suppresses nothing, because an
   * address-wide row would also silence the merchant's notices and every other
   * account sharing the address. Signed with the rest, so a
   * customer token can never be read as a digest token or the reverse.
   */
  list?: "digest";
}

/** Sign an unsubscribe payload into a compact `payload.signature` token. */
export async function signUnsubscribeToken(
  env: Env,
  payload: UnsubscribeTokenPayload,
): Promise<string> {
  return signToken(linkKeys(env), payload);
}

/** Verify + parse an unsubscribe token. Returns null on tamper/format/parse failure. */
export async function verifyUnsubscribeToken(
  env: Env,
  token: string,
): Promise<UnsubscribeTokenPayload | null> {
  const parsed = (await readSignedToken(linkKeys(env), token)) as UnsubscribeTokenPayload | null;
  if (!parsed) return null;
  if (!parsed.email || !parsed.accountId) return null;
  if (parsed.list !== undefined && parsed.list !== "digest") return null;
  return parsed.list === "digest"
    ? { email: parsed.email, accountId: parsed.accountId, list: "digest" }
    : { email: parsed.email, accountId: parsed.accountId };
}
