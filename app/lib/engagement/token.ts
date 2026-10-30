import { readSignedToken, signToken } from "@dustinedwards/site-runtime/signed-token";
import { linkKeys } from "~/lib/http/signed-token";

// First-party engagement tokens. The open-pixel and click-redirect URLs carry a
// signed token instead of any PII (ROUTES.md: "no PII in URL beyond the token").
// The token is HMAC-signed (integrity, not secrecy: the payload holds only ids
// and the click destination), so a tampered token is rejected. Keyed on
// ENCRYPTION_KEY (a stable 32-byte hex secret already required by the engine).

export interface EngagementTokenPayload {
  /** recovery_steps.id the email belongs to. */
  stepId: string;
  accountId: string;
  kind: "open" | "click" | "honeypot";
  /** Click destination (absent for opens). Only http(s) is honored at redirect time. */
  url?: string;
}

/** Sign an engagement payload into a compact `payload.signature` token. */
export async function signEngagementToken(
  env: Env,
  payload: EngagementTokenPayload,
): Promise<string> {
  return signToken(linkKeys(env), payload);
}

/** Verify + parse an engagement token. Returns null on any tamper/format/parse failure. */
export async function verifyEngagementToken(
  env: Env,
  token: string,
): Promise<EngagementTokenPayload | null> {
  const parsed = (await readSignedToken(linkKeys(env), token)) as EngagementTokenPayload | null;
  if (!parsed) return null;
  if (!parsed.stepId || !parsed.accountId || (parsed.kind !== "open" && parsed.kind !== "click" && parsed.kind !== "honeypot")) {
    return null;
  }
  return parsed;
}
