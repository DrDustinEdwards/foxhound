import { readSignedToken, signToken } from "@dustinedwards/site-runtime/signed-token";
import { linkKeys } from "~/lib/http/signed-token";

// First-party engagement tokens: the open-pixel and click URLs carry a signed token, no PII. HMAC for
// integrity, not secrecy (ids and the click destination only), keyed on ENCRYPTION_KEY.

export interface EngagementTokenPayload {
  stepId: string;
  accountId: string;
  kind: "open" | "click" | "honeypot";
  url?: string;
}

export async function signEngagementToken(
  env: Env,
  payload: EngagementTokenPayload,
): Promise<string> {
  return signToken(linkKeys(env), payload);
}

export async function verifyEngagementToken(
  env: Env,
  token: string,
): Promise<EngagementTokenPayload | null> {
  const parsed = (await readSignedToken(linkKeys(env), token)) as EngagementTokenPayload | null;
  if (!parsed) return null;
  if (
    !parsed.stepId ||
    !parsed.accountId ||
    (parsed.kind !== "open" && parsed.kind !== "click" && parsed.kind !== "honeypot")
  ) {
    return null;
  }
  return parsed;
}
