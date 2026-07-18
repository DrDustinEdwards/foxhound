import { CARD_UPDATE_TOKEN_MAX_AGE_MS } from "~/lib/constants";

// Stateless HMAC-signed token for the hosted card-update page (/p/:token,
// ROUTES.md public-utility). Mirrors the /e/* engagement token pattern
// (app/lib/engagement/token.ts): HMAC for integrity, not secrecy (the
// payload carries no PII, only ids), keyed on ENCRYPTION_KEY. Unlike an
// engagement token, this one carries an issued-at timestamp and expires
// (CARD_UPDATE_TOKEN_MAX_AGE_MS): a stale link asking a customer to enter a
// new card should not work forever.

export interface CardUpdateTokenPayload {
  /** failed_payments.id this card update applies to. */
  failedPaymentId: string;
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
    if (!parsed.failedPaymentId || !parsed.accountId || typeof parsed.iat !== "number") {
      return null;
    }
    if (Date.now() - parsed.iat > CARD_UPDATE_TOKEN_MAX_AGE_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}
