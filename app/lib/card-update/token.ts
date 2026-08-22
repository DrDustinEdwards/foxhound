import { CARD_UPDATE_TOKEN_MAX_AGE_MS } from "~/lib/constants";

// Stateless HMAC-signed token for the hosted card-update page (/p/:token,
// ROUTES.md public-utility). Mirrors the /e/* engagement token pattern
// (app/lib/engagement/token.ts): HMAC for integrity, not secrecy (the
// payload carries no PII, only ids), keyed on ENCRYPTION_KEY. Unlike an
// engagement token, this one carries an issued-at timestamp and expires
// (CARD_UPDATE_TOKEN_MAX_AGE_MS): a stale link asking a customer to enter a
// new card should not work forever.

/**
 * THREE MODES, exactly one id each (341 binding 2, extended by 343 binding 4).
 *
 * RECOVERY MODE carries `failedPaymentId`: a payment failed, the dunning email
 * links here, and a successful update records the `card_update` attribution
 * signal the recovery path reads.
 *
 * ALERT MODE carries `expiringCardAlertId`: nothing has failed yet. An
 * expiring-card alert warns a customer before the card lapses, so there IS no
 * failed payment to name, which is why `failedPaymentId` had to become
 * optional. An alert-mode update triggers no retry, writes no recovery step and
 * records no attribution signal: the alert's own outcome is the record.
 *
 * RESUBSCRIBE MODE carries `winBackSequenceId` and its step number: the
 * customer CANCELLED, nothing failed and no card is being collected. Legacy's
 * button here is a Stripe billing portal session; 343 binding 4 replaces it
 * with a Checkout Session in `subscription` mode created on CLICK, so no Stripe
 * object exists at send time.
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
  /** Which win-back step's email carried this link. Metadata only; required
   *  whenever `winBackSequenceId` is set, so the step can never go unrecorded
   *  on the Checkout Session that session 52 matches on. */
  winBackStepNumber?: number;
  accountId: string;
  /** Epoch ms the token was issued, for expiry. */
  iat: number;
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function signingKey(env: Env): Promise<CryptoKey> {
  if (!env.ENCRYPTION_KEY) throw new Error("ENCRYPTION_KEY is not set");
  return crypto.subtle.importKey(
    "raw",
    hexToBytes(env.ENCRYPTION_KEY),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** Sign a card-update payload into a compact `payload.signature` token. Stamps `iat` itself. */
export async function signCardUpdateToken(
  env: Env,
  payload: Omit<CardUpdateTokenPayload, "iat">,
): Promise<string> {
  const full: CardUpdateTokenPayload = { ...payload, iat: Date.now() };
  const key = await signingKey(env);
  const payloadBytes = new Uint8Array(new TextEncoder().encode(JSON.stringify(full)));
  const sig = await crypto.subtle.sign("HMAC", key, payloadBytes);
  return `${b64urlEncode(payloadBytes)}.${b64urlEncode(new Uint8Array(sig))}`;
}

/** Verify + parse a card-update token. Returns null on tamper/format/parse
 *  failure or if the token is older than CARD_UPDATE_TOKEN_MAX_AGE_MS. */
export async function verifyCardUpdateToken(
  env: Env,
  token: string,
): Promise<CardUpdateTokenPayload | null> {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  try {
    const key = await signingKey(env);
    const payloadBytes = b64urlDecode(token.slice(0, dot));
    const sig = b64urlDecode(token.slice(dot + 1));
    const ok = await crypto.subtle.verify("HMAC", key, sig, payloadBytes);
    if (!ok) return null;
    const parsed = JSON.parse(new TextDecoder().decode(payloadBytes)) as CardUpdateTokenPayload;
    // EXACTLY ONE MODE. A token carrying no id is refused here rather than
    // resolving to nothing downstream, and a token carrying more than one is
    // refused rather than letting the route's dispatch order silently pick a
    // winner. This is the fail-closed half of making `failedPaymentId` optional
    // (341 binding 2): the fields are optional, the REQUIREMENT that a token
    // names exactly one target is not.
    const targets = [
      parsed.failedPaymentId,
      parsed.expiringCardAlertId,
      parsed.winBackSequenceId,
    ].filter(Boolean).length;
    if (targets !== 1 || !parsed.accountId || typeof parsed.iat !== "number") {
      return null;
    }
    // Resubscribe mode carries its step number into the Checkout Session's
    // metadata; a sequence id with no step number would mint a session that
    // session 52 could match but never attribute to a step.
    if (parsed.winBackSequenceId && typeof parsed.winBackStepNumber !== "number") {
      return null;
    }
    if (Date.now() - parsed.iat > CARD_UPDATE_TOKEN_MAX_AGE_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}
