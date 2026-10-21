import type { AdminMcpEnv } from "./env";

// Tightened Dynamic Client Registration (MCP ruling 2026-10-10, rule 13), beside
// CIMD. Claude, Claude Code and ChatGPT identify themselves by a client metadata
// document; Grok and Gemini still register, as of 2026-10-09, so this server
// registers them under four limits, the same four Carrel uses:
//
//   1. Redirect URIs allowlisted exactly, compared as whole strings: no prefix,
//      no pattern, no localhost.
//   2. Registration grants nothing. It stores a client id and no grant, token or
//      scope; the client still sends the person through the consent page and the
//      Access sign-in, and the API still decides whether they are an admin.
//   3. Consent per client, on every authorization (door.ts).
//   4. Rate limited: a few registrations an hour from one address, a ceiling a
//      day for all.
//
// REMOVAL CONDITION: delete this file, and clientRegistrationEndpoint in door.ts,
// when Grok and Gemini sign in by CIMD, and at the latest when the MCP
// specification removes registration (after summer 2027).

/** Grok's two connector callbacks, ChatGPT's fixed connector callback, and
 *  Google's Gemini Enterprise redirect. A callback carrying a per-connector id
 *  is added exactly, in DCR_REDIRECT_URIS. */
export const DCR_REDIRECT_URIS: readonly string[] = [
  "https://grok.com/connectors/oauth/callback",
  "https://grok.com/connectors-oauth-exchange-code/",
  "https://chatgpt.com/connector_platform_oauth_redirect",
  "https://vertexaisearch.cloud.google.com/oauth-redirect",
];

const PER_ADDRESS_PER_HOUR = 5;
const ALL_PER_DAY = 30;
export const REGISTER_PATH = "/register";

export function allowedRedirects(env: Pick<AdminMcpEnv, "DCR_REDIRECT_URIS">): Set<string> {
  const extra = (env.DCR_REDIRECT_URIS ?? "").split(/[\s,]+/).filter((uri) => uri.startsWith("https://"));
  return new Set([...DCR_REDIRECT_URIS, ...extra]);
}

type Refusal = { code: string; description: string; status: number };

/** The registration policy, for the provider's clientRegistrationCallback. */
export function checkRegistration(allowed: ReadonlySet<string>, metadata: Record<string, unknown>): Refusal | undefined {
  const refuse = (description: string): Refusal => ({ code: "invalid_redirect_uri", description, status: 400 });
  const uris = metadata.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 5) {
    return refuse("redirect_uris must list one to five callbacks.");
  }
  for (const uri of uris) {
    if (typeof uri !== "string" || !allowed.has(uri)) {
      return refuse(
        `${String(uri).slice(0, 200)} is not a callback Foxhound Admin registers. Only the exact callbacks of the AI apps Dustin uses are allowed.`,
      );
    }
  }
  return undefined;
}

type CounterStore = Pick<KVNamespace, "get" | "put">;

/** Counts one registration attempt; answers the 429 to send, or null. */
export async function registrationLimited(
  request: Request,
  env: { OAUTH_KV: CounterStore },
  now = Date.now(),
): Promise<Response | null> {
  const address = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const hour = Math.floor(now / 3_600_000);
  const day = Math.floor(now / 86_400_000);
  const keys = [
    { key: `dcr-rate:addr:${address}:${hour}`, limit: PER_ADDRESS_PER_HOUR, ttl: 3_700 },
    { key: `dcr-rate:all:${day}`, limit: ALL_PER_DAY, ttl: 86_500 },
  ];
  const counts = await Promise.all(keys.map(async (k) => Number((await env.OAUTH_KV.get(k.key)) ?? 0)));
  if (keys.some((k, i) => counts[i]! >= k.limit)) {
    console.warn(JSON.stringify({ door: "registration-limited", address }));
    return new Response(
      JSON.stringify({ error: "temporarily_unavailable", error_description: "Too many registrations. Try again later." }),
      { status: 429, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Retry-After": "3600" } },
    );
  }
  await Promise.all(keys.map((k, i) => env.OAUTH_KV.put(k.key, String(counts[i]! + 1), { expirationTtl: k.ttl })));
  return null;
}
