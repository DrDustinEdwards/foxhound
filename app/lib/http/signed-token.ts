// The one stateless HMAC token format behind the links Foxhound emails: the
// card-update page (/p/), the unsubscribe link (/u/) and the engagement pixel
// and click redirect (/e/). `base64url(JSON payload).base64url(HMAC-SHA-256)`,
// keyed on ENCRYPTION_KEY: integrity, not secrecy, so a payload carries ids and
// never anything private. Each caller checks its own payload's shape.

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

/** Sign a JSON payload into a compact `payload.signature` token. */
export async function signToken(env: Env, payload: object): Promise<string> {
  const key = await signingKey(env);
  const payloadBytes = new Uint8Array(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", key, payloadBytes);
  return `${b64urlEncode(payloadBytes)}.${b64urlEncode(new Uint8Array(sig))}`;
}

/** Verify a token's signature and parse its payload. Null on any tamper,
 *  format or parse failure, or when the payload is not a JSON object. The
 *  caller still checks the payload's own fields. */
export async function readSignedToken(env: Env, token: string): Promise<Record<string, unknown> | null> {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  try {
    const key = await signingKey(env);
    const payloadBytes = b64urlDecode(token.slice(0, dot));
    const sig = b64urlDecode(token.slice(dot + 1));
    if (!(await crypto.subtle.verify("HMAC", key, sig, payloadBytes))) return null;
    const parsed: unknown = JSON.parse(new TextDecoder().decode(payloadBytes));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
