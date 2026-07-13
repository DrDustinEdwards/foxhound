// First-party engagement tokens. The open-pixel and click-redirect URLs carry a
// signed token instead of any PII (ROUTES.md: "no PII in URL beyond the token").
// The token is HMAC-signed (integrity, not secrecy: the payload holds only ids
// and the click destination), so a tampered token is rejected. Keyed on
// ENCRYPTION_KEY (a stable 32-byte hex secret already required by the engine).

export interface EngagementTokenPayload {
  /** recovery_steps.id the email belongs to. */
  stepId: string;
  accountId: string;
  kind: "open" | "click";
  /** Click destination (absent for opens). Only http(s) is honored at redirect time. */
  url?: string;
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

/** Sign an engagement payload into a compact `payload.signature` token. */
export async function signEngagementToken(
  env: Env,
  payload: EngagementTokenPayload,
): Promise<string> {
  const key = await signingKey(env);
  const payloadBytes = new Uint8Array(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", key, payloadBytes);
  return `${b64urlEncode(payloadBytes)}.${b64urlEncode(new Uint8Array(sig))}`;
}

/** Verify + parse an engagement token. Returns null on any tamper/format/parse failure. */
export async function verifyEngagementToken(
  env: Env,
  token: string,
): Promise<EngagementTokenPayload | null> {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  try {
    const key = await signingKey(env);
    const payloadBytes = b64urlDecode(token.slice(0, dot));
    const sig = b64urlDecode(token.slice(dot + 1));
    const ok = await crypto.subtle.verify("HMAC", key, sig, payloadBytes);
    if (!ok) return null;
    const parsed = JSON.parse(new TextDecoder().decode(payloadBytes)) as EngagementTokenPayload;
    if (!parsed.stepId || !parsed.accountId || (parsed.kind !== "open" && parsed.kind !== "click")) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
