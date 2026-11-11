// A merchant's Slack incoming-webhook URL is a bearer credential: anyone who
// holds it can post into their workspace. So accounts.slack_webhook_url holds it
// sealed with the same AES-256-GCM keyring as the Stripe tokens
// (app/lib/stripe/encryption.ts, `v1:keyId:iv:cipher`), never the URL itself,
// and a D1 export or backup carries no usable webhook. Every write seals here
// and every read opens here; nothing else touches the column's value.
//
// No plaintext fallback: on 2026-11-11, before this landed, production held zero
// accounts with a webhook set, so no stored value needs a migration. A value
// that is not in the v1 format makes decryptToken throw, loudly.

import { decryptToken, encryptToken } from "~/lib/stripe/encryption";

/** The column's value for a normalized URL: sealed, or null to clear it. */
export async function sealSlackWebhook(env: Env, url: string | null): Promise<string | null> {
  return url ? encryptToken(env, url) : null;
}

/** The URL a stored value holds, or null when none is set. Throws on a value it cannot open. */
export async function openSlackWebhook(env: Env, stored: string | null): Promise<string | null> {
  return stored ? decryptToken(env, stored) : null;
}
