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

/** Sign an unsubscribe payload into a compact `payload.signature` token. */
export async function signUnsubscribeToken(
  env: Env,
  payload: UnsubscribeTokenPayload,
): Promise<string> {
  const key = await signingKey(env);
  const payloadBytes = new Uint8Array(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", key, payloadBytes);
  return `${b64urlEncode(payloadBytes)}.${b64urlEncode(new Uint8Array(sig))}`;
}

/** Verify + parse an unsubscribe token. Returns null on tamper/format/parse failure. */
export async function verifyUnsubscribeToken(
  env: Env,
  token: string,
): Promise<UnsubscribeTokenPayload | null> {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  try {
    const key = await signingKey(env);
    const payloadBytes = b64urlDecode(token.slice(0, dot));
    const sig = b64urlDecode(token.slice(dot + 1));
    const ok = await crypto.subtle.verify("HMAC", key, sig, payloadBytes);
    if (!ok) return null;
    const parsed = JSON.parse(new TextDecoder().decode(payloadBytes)) as UnsubscribeTokenPayload;
    if (!parsed.email || !parsed.accountId) return null;
    return parsed;
  } catch {
    return null;
  }
}
