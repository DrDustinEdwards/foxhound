// The one stateless HMAC token format behind the links Foxhound emails: the
// card-update page (/p/), the unsubscribe link (/u/) and the engagement pixel
// and click redirect (/e/). `base64url(JSON payload).base64url(HMAC-SHA-256)`:
// integrity, not secrecy, so a payload carries ids and never anything private.
// Each caller checks its own payload's shape.
//
// ITS OWN KEY, EMAIL_TOKEN_KEY, so the key that encrypts Stripe tokens at rest
// (ENCRYPTION_KEY, app/lib/stripe/encryption.ts) is not also an HMAC key for
// links anyone can request by the thousand. Until that secret is set, signing
// falls back to ENCRYPTION_KEY, as every link was signed before. Verification
// accepts either key while both exist, so links already in inboxes keep working
// once EMAIL_TOKEN_KEY is set; the ENCRYPTION_KEY fallback can be removed once
// the longest-lived of those links has aged out.

import { base64url, fromBase64url, fromHex } from "@dustinedwards/site-runtime/encoding";

function hmacKey(hex: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", fromHex(hex), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/** The key new links are signed with: EMAIL_TOKEN_KEY, else ENCRYPTION_KEY. */
async function signingKey(env: Env): Promise<CryptoKey> {
  const hex = env.EMAIL_TOKEN_KEY || env.ENCRYPTION_KEY;
  if (!hex) throw new Error("EMAIL_TOKEN_KEY and ENCRYPTION_KEY are not set");
  return hmacKey(hex);
}

/** Every key a link may have been signed with, the signing key first. */
async function verifyingKeys(env: Env): Promise<CryptoKey[]> {
  const hexes = [env.EMAIL_TOKEN_KEY, env.ENCRYPTION_KEY].filter((hex): hex is string => Boolean(hex));
  if (hexes.length === 0) throw new Error("EMAIL_TOKEN_KEY and ENCRYPTION_KEY are not set");
  return Promise.all([...new Set(hexes)].map(hmacKey));
}

/** Sign a JSON payload into a compact `payload.signature` token. */
export async function signToken(env: Env, payload: object): Promise<string> {
  const key = await signingKey(env);
  const payloadBytes = new Uint8Array(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", key, payloadBytes);
  return `${base64url(payloadBytes)}.${base64url(new Uint8Array(sig))}`;
}

/** Verify a token's signature and parse its payload. Null on any tamper,
 *  format or parse failure, or when the payload is not a JSON object. The
 *  caller still checks the payload's own fields. */
export async function readSignedToken(env: Env, token: string): Promise<Record<string, unknown> | null> {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  try {
    const payloadBytes = fromBase64url(token.slice(0, dot));
    const sig = fromBase64url(token.slice(dot + 1));
    let verified = false;
    for (const key of await verifyingKeys(env)) {
      if (await crypto.subtle.verify("HMAC", key, sig, payloadBytes)) {
        verified = true;
        break;
      }
    }
    if (!verified) return null;
    const parsed: unknown = JSON.parse(new TextDecoder().decode(payloadBytes));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
