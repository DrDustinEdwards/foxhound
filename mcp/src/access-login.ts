import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

import type { AdminMcpEnv } from "./env";

// The upstream sign-in: Cloudflare Access for SaaS as an OIDC provider, the same
// arrangement Carrel's AI door uses. This Worker is the OAuth authorization
// server for MCP clients (door.ts); it does not know who the person is, so it
// sends them to Access, which returns an ID token whose verified email the
// admin API then checks against ADMIN_EMAIL. Fails closed: a missing setting
// keeps the door shut.

export type AccessSaas = {
  clientId: string;
  clientSecret: string;
  issuer: string;
  authorizationUrl: string;
  tokenUrl: string;
  jwksUrl: string;
};

/** https://<team>.cloudflareaccess.com, from the team domain however it was written. */
function teamIssuer(team: string): string {
  return `https://${team.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;
}

export function accessSaas(env: AdminMcpEnv): AccessSaas | null {
  const team = env.ACCESS_TEAM_DOMAIN?.trim();
  const clientId = env.ACCESS_SAAS_CLIENT_ID?.trim();
  const clientSecret = env.ACCESS_SAAS_CLIENT_SECRET?.trim();
  if (!team || !clientId || !clientSecret) return null;
  const issuer = `${teamIssuer(team)}/cdn-cgi/access/sso/oidc/${encodeURIComponent(clientId)}`;
  return {
    clientId,
    clientSecret,
    issuer,
    authorizationUrl: `${issuer}/authorization`,
    tokenUrl: `${issuer}/token`,
    jwksUrl: `${issuer}/jwks`,
  };
}

const remoteKeys = new Map<string, JWTVerifyGetKey>();

function keysFor(saas: AccessSaas): JWTVerifyGetKey {
  let keys = remoteKeys.get(saas.jwksUrl);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(saas.jwksUrl));
    remoteKeys.set(saas.jwksUrl, keys);
  }
  return keys;
}

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function newSignIn(): { verifier: string; nonce: string } {
  return { verifier: `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, ""), nonce: crypto.randomUUID() };
}

export async function authorizationUrl(
  saas: AccessSaas,
  input: { redirectUri: string; state: string; verifier: string; nonce: string },
): Promise<string> {
  const url = new URL(saas.authorizationUrl);
  url.searchParams.set("client_id", saas.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", input.state);
  url.searchParams.set("nonce", input.nonce);
  url.searchParams.set("code_challenge", await s256(input.verifier));
  url.searchParams.set("code_challenge_method", "S256");
  return url.href;
}

export type SignedIn = { ok: true; email: string } | { ok: false; reason: string };

/** Exchange Access's code and verify the ID token: signed by the SaaS app,
 *  issued by it, for this client, carrying this sign-in's nonce and a verified
 *  email. Anything else is a refusal. */
export async function finishSignIn(
  saas: AccessSaas,
  input: { code: string; redirectUri: string; verifier: string; nonce: string },
  keys: JWTVerifyGetKey = keysFor(saas),
): Promise<SignedIn> {
  const response = await fetch(saas.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: saas.clientId,
      client_secret: saas.clientSecret,
      code_verifier: input.verifier,
    }),
  });
  if (!response.ok) return { ok: false, reason: `token-exchange-${response.status}` };
  const tokens = (await response.json().catch(() => ({}))) as { id_token?: unknown };
  if (typeof tokens.id_token !== "string") return { ok: false, reason: "no-id-token" };
  let payload;
  try {
    ({ payload } = await jwtVerify(tokens.id_token, keys, {
      issuer: saas.issuer,
      audience: saas.clientId,
      algorithms: ["RS256"],
    }));
  } catch {
    return { ok: false, reason: "invalid-id-token" };
  }
  if (payload.nonce !== input.nonce) return { ok: false, reason: "nonce-mismatch" };
  if (payload.email_verified === false) return { ok: false, reason: "email-not-verified" };
  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  if (!email) return { ok: false, reason: "no-email" };
  return { ok: true, email };
}
