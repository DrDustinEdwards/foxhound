import type Database from "better-sqlite3";
import { RouterContextProvider } from "react-router";
import { beforeEach, expect, vi } from "vitest";

import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import { safeNextPath } from "@dustinedwards/site-runtime/sign-in-form";

import { createInMemoryDb } from "./inmemory-db";
import { toolCallLogStub } from "./mcp-client";

export const landing = (raw: unknown) => safeNextPath(raw, { fallback: "/console" });

// The OAuth provider external agents connect through. The access token is a
// fox_mcp_ key the /mcp door already verifies, so an OAuth caller reaches the
// merchant tools and nothing else, and the account is the one the signed-in
// person had active at consent, never an argument.
//
// Every assertion drives the real functions against the committed migrations.

const harness = vi.hoisted(() => ({
  db: null as unknown,
  session: null as unknown,
  allowed: true,
  /** Buckets the limiter refuses, and whether it is down. */
  limitedBuckets: [] as string[],
  limiterDown: false,
}));

export { harness };

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

vi.mock("~/lib/auth/session", () => ({
  getSession: async () => harness.session,
}));

// @cloudflare/workers-oauth-provider, which fetches a client metadata
// document, imports this module for a class it never constructs here.
vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));

export const provider = await import("~/lib/oauth/provider.server");
export const authorizeRoute = await import("~/routes/oauth/authorize");
export const tokenRoute = await import("~/routes/api/oauth-token");
export const registerRoute = await import("~/routes/api/oauth-register");
export const revokeRoute = await import("~/routes/api/oauth-revoke");
export const metadataRoute = await import("~/routes/files/oauth-metadata");
export const resourceRoute = await import("~/routes/files/oauth-protected-resource");
export const { handleMcpRequest } = await import("~/lib/mcp/handler.server");

export const ORIGIN = "https://foxhoundapp.test";
export const USER = "user_1";
export const ACCOUNT_A = "acct_a";
export const ACCOUNT_B = "acct_b";
export const NOW = new Date("2026-10-16T12:00:00.000Z");
export const CLAUDE_REDIRECT = "https://claude.ai/api/mcp/auth_callback";
/** The registration allowlist these tests run with, as DCR_REDIRECT_URIS would set it. */
export const ALLOWED = provider.registrationCallbacks({ DCR_REDIRECT_URIS: CLAUDE_REDIRECT });

export let sqlite: Database.Database;
export let db: ReturnType<typeof createInMemoryDb>["db"];

export function env(): Env {
  return {
    DB: {},
    BETTER_AUTH_URL: ORIGIN,
    DCR_REDIRECT_URIS: CLAUDE_REDIRECT,
    TOOL_CALL_LOG: toolCallLogStub(),
    RATE_LIMITER: {
      idFromName: (n: string) => n,
      get: (name: string) => ({
        hit: async () => {
          if (harness.limiterDown) throw new Error("limiter down");
          const ok = harness.allowed && !harness.limitedBuckets.includes(name.split(":")[0]);
          return { ok, retryAfterSeconds: 60 };
        },
      }),
    },
  } as unknown as Env;
}

export function context(): RouterContextProvider {
  const ctx = new RouterContextProvider();
  ctx.set(cloudflareContext, { env: env(), ctx: {} as ExecutionContext });
  return ctx;
}

beforeEach(() => {
  ({ sqlite, db } = createInMemoryDb());
  harness.db = db;
  harness.allowed = true;
  harness.limitedBuckets = [];
  harness.limiterDown = false;
  sqlite
    .prepare(
      "INSERT INTO user (id, name, email, email_verified, updated_at) VALUES (?, ?, ?, 0, 0)",
    )
    .run(USER, "Dana", "dana@acme.test");
  for (const [id, name, at] of [
    [ACCOUNT_A, "Acme Supply Co.", 1_000],
    [ACCOUNT_B, "Beta Ltd", 2_000],
  ] as const) {
    sqlite
      .prepare("INSERT INTO accounts (id, name, created_at) VALUES (?, ?, ?)")
      .run(id, name, at);
    sqlite
      .prepare(
        "INSERT INTO account_members (id, account_id, user_id, role, status, created_at) VALUES (?, ?, ?, 'owner', 'active', ?)",
      )
      .run(`m_${id}`, id, USER, at);
  }
  // The SECOND account is the active one, so a wrong pick of the earliest
  // membership cannot pass by accident.
  harness.session = {
    user: { id: USER, name: "Dana", email: "dana@acme.test" },
    session: { id: "sess_1", activeAccountId: ACCOUNT_B },
  };
});

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  return { verifier, challenge: b64url(digest) };
}

export async function registered(redirectUris: string[] = [CLAUDE_REDIRECT]): Promise<string> {
  const res = await provider.registerClient(
    db,
    { client_name: "Claude", redirect_uris: redirectUris },
    NOW,
    ALLOWED,
  );
  expect(res.status).toBe(201);
  return res.body.client_id as string;
}

export function authorizeParams(
  clientId: string,
  challenge: string,
  extra: Record<string, string> = {},
) {
  return new URLSearchParams({
    client_id: clientId,
    redirect_uri: CLAUDE_REDIRECT,
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "st_123",
    ...extra,
  });
}

/** Consent through the real action, returning the code from the redirect.
 *  `allowWrite` is the owner ticking "Allow changes". */
export async function consent(
  clientId: string,
  challenge: string,
  intent = "allow",
  allowWrite = false,
): Promise<URL> {
  const form = authorizeParams(clientId, challenge);
  form.set("intent", intent);
  if (allowWrite) form.set("allow_write", "1");
  // The account the card showed, posted back as a consistency check only.
  form.set("account_id", ACCOUNT_B);
  const request = new Request(`${ORIGIN}/oauth/authorize`, {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  const res = (await authorizeRoute.action({
    request,
    context: context(),
    params: {},
  } as never)) as Response;
  expect(res.status, "the action answers with a redirect").toBeGreaterThanOrEqual(300);
  expect(res.status).toBeLessThan(400);
  return new URL(res.headers.get("Location")!);
}

export async function tokenCall(
  fields: Record<string, string>,
  json = false,
): Promise<{ status: number; body: Record<string, unknown>; res: Response }> {
  const request = new Request(`${ORIGIN}/api/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": json ? "application/json" : "application/x-www-form-urlencoded" },
    body: json ? JSON.stringify(fields) : new URLSearchParams(fields),
  });
  const res = (await tokenRoute.action({
    request,
    context: context(),
    params: {},
  } as never)) as Response;
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, res };
}

export async function fullFlow(): Promise<{ clientId: string; access: string; refresh: string }> {
  const clientId = await registered();
  const { verifier, challenge } = await pkcePair();
  const back = await consent(clientId, challenge);
  const { status, body } = await tokenCall({
    grant_type: "authorization_code",
    code: back.searchParams.get("code")!,
    code_verifier: verifier,
    client_id: clientId,
    redirect_uri: CLAUDE_REDIRECT,
  });
  expect(status).toBe(200);
  return { clientId, access: body.access_token as string, refresh: body.refresh_token as string };
}
