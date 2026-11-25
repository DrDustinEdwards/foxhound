import { CARD_UPDATE_TOKEN_MAX_AGE_MS } from "~/lib/constants";
import { readSignedToken, signToken } from "@dustinedwards/site-runtime/signed-token";
import { linkKeys } from "~/lib/http/signed-token";

// Stateless HMAC-signed token for the hosted card-update page (/p/:token). Mirrors the /e/* engagement token pattern (app/lib/engagement/token.ts): HMAC for integrity, not secrecy (the payload carries only ids), keyed on ENCRYPTION_KEY.

/**
 * THREE MODES, exactly one id each.
 *
 * `verifyCardUpdateToken` refuses a token carrying NO id and a token carrying
 * MORE THAN ONE, so the optional fields cannot become a way to mint a token
 * that resolves to nothing, or to two things at once.
 */
export interface CardUpdateTokenPayload {
  /** failed_payments.id this card update applies to. Recovery mode. */
  failedPaymentId?: string;
  /** expiring_card_alerts.id this card update applies to. Alert mode. */
  expiringCardAlertId?: string;
  /** win_back_sequences.id this resubscribe applies to. Resubscribe mode. */
  winBackSequenceId?: string;
  /** Which win-back step's email carried this link. */
  winBackStepNumber?: number;
  accountId: string;
  /** Epoch ms the token was issued, for expiry. */
  iat: number;
}

/**
 * Sign a card-update payload into a compact `payload.signature` token. Stamps
 * `iat` itself.
 */
export async function signCardUpdateToken(
  env: Env,
  payload: Omit<CardUpdateTokenPayload, "iat">,
): Promise<string> {
  const full: CardUpdateTokenPayload = { ...payload, iat: Date.now() };
  return signToken(linkKeys(env), full);
}

/**
 * Verify + parse a card-update token. Returns null on tamper/format/parse
 * failure or if the token is older than CARD_UPDATE_TOKEN_MAX_AGE_MS.
 */
export async function verifyCardUpdateToken(
  env: Env,
  token: string,
): Promise<CardUpdateTokenPayload | null> {
  const parsed = (await readSignedToken(linkKeys(env), token)) as CardUpdateTokenPayload | null;
  if (!parsed) return null;
  // EXACTLY ONE MODE. A token carrying no id is refused here rather than
  // resolving to nothing downstream, and a token carrying more than one is
  // refused rather than letting the route's dispatch order silently pick a
  // winner.
  const targets = [
    parsed.failedPaymentId,
    parsed.expiringCardAlertId,
    parsed.winBackSequenceId,
  ].filter(Boolean).length;
  if (targets !== 1 || !parsed.accountId || typeof parsed.iat !== "number") {
    return null;
  }
  if (parsed.winBackSequenceId && typeof parsed.winBackStepNumber !== "number") {
    return null;
  }
  if (Date.now() - parsed.iat > CARD_UPDATE_TOKEN_MAX_AGE_MS) return null;
  return parsed;
}
