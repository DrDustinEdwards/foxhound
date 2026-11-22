// A merchant's Slack incoming-webhook URL is a bearer credential: anyone who holds it can post into
// their workspace.

import { decryptToken, encryptToken } from "~/lib/stripe/encryption";

/** The column's value for a normalized URL: sealed, or null to clear it. */
export async function sealSlackWebhook(env: Env, url: string | null): Promise<string | null> {
  return url ? encryptToken(env, url) : null;
}

/** The URL a stored value holds, or null when none is set. Throws on a value it cannot open. */
export async function openSlackWebhook(env: Env, stored: string | null): Promise<string | null> {
  return stored ? decryptToken(env, stored) : null;
}
