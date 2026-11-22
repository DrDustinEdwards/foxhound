import { readSignedToken, signToken } from "@dustinedwards/site-runtime/signed-token";
import { linkKeys } from "~/lib/http/signed-token";

// Stateless HMAC-signed token for the CAN-SPAM one-click unsubscribe link (/u/:token), keyed on ENCRYPTION_KEY.
// The payload carries only the address and account. It does not expire: an opt-out link must work indefinitely.

export interface UnsubscribeTokenPayload {
  email: string;
  accountId: string;
  /** Absent: the address-wide unsubscribe. "digest": the weekly digest only, which suppresses nothing (an
   *  address-wide row would silence every other mail and account on the address). Signed, so the two kinds
   *  cannot be swapped. */
  list?: "digest";
}

export async function signUnsubscribeToken(
  env: Env,
  payload: UnsubscribeTokenPayload,
): Promise<string> {
  return signToken(linkKeys(env), payload);
}

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
