import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { getAdminSession } from "~/lib/auth/access.server";

// The Cloudflare Access gate in front of /admin: Foxhound's own part of it (the
// allowlist, the cookie, failing closed, the dev bypass). The token checks
// themselves are site-runtime's and tested there.

const TEAM = "https://foxhound-test.cloudflareaccess.com";
const AUD = "aud-tag-123";
const ADMIN = "admin@example.com";

let privateKey: CryptoKey;
let jwks: { keys: unknown[] };

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256", use: "sig" }] };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubKeys() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(`${TEAM}/cdn-cgi/access/certs`);
      return new Response(JSON.stringify(jwks), { headers: { "Content-Type": "application/json" } });
    }),
  );
}

function env(overrides: Partial<Env> = {}): Env {
  return { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ADMIN_EMAIL: ADMIN, ...overrides } as Env;
}

async function token(
  claims: { email?: string; aud?: string; iss?: string; exp?: string } = {},
  key: CryptoKey = privateKey,
): Promise<string> {
  return new SignJWT(claims.email === undefined ? {} : { email: claims.email })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(claims.iss ?? TEAM)
    .setAudience(claims.aud ?? AUD)
    .setIssuedAt()
    .setExpirationTime(claims.exp ?? "5m")
    .sign(key);
}

function request(headers: Record<string, string> = {}, url = "https://foxhoundapp.com/admin"): Request {
  return new Request(url, { headers });
}

describe("getAdminSession (Cloudflare Access)", () => {

  it("accepts the same token from the CF_Authorization cookie", async () => {
    stubKeys();
    const jwt = await token({ email: ADMIN });
    expect(await getAdminSession(env(), request({ Cookie: `a=1; CF_Authorization=${jwt}` }))).toEqual({ email: ADMIN });
  });

  it("refuses an email that Access let in but the allowlist does not hold", async () => {
    stubKeys();
    const jwt = await token({ email: "someone@example.com" });
    expect(await getAdminSession(env(), request({ "Cf-Access-Jwt-Assertion": jwt }))).toBeNull();
  });

  it("the dev bypass works on localhost only", async () => {
    const dev = env({ ACCESS_DEV_BYPASS: "1", ACCESS_TEAM_DOMAIN: undefined, ACCESS_AUD: undefined });
    expect(await getAdminSession(dev, request({}, "http://localhost:5173/admin"))).toEqual({ email: ADMIN });
    expect(await getAdminSession(dev, request({}, "https://foxhoundapp.com/admin"))).toBeNull();
  });
});

describe("the /admin gate (admin-shell middleware)", () => {
  it("answers 404 and runs nothing when there is no admin session", async () => {
    const { middleware } = await import("~/layouts/admin-shell");
    const context = { get: () => ({ env: env() }), set: () => {} };
    const next = vi.fn(async () => new Response("ran"));
    const outcome = await Promise.resolve(
      middleware[0]!({ request: request(), context, params: {} } as never, next as never),
    ).catch((e: unknown) => e);
    expect(next).not.toHaveBeenCalled();
    expect((outcome as Response).status).toBe(404);
  });

  it("lets a same-origin POST through and answers a cross-site one 403, for a signed-in admin", async () => {
    const { middleware } = await import("~/layouts/admin-shell");
    const dev = env({ ACCESS_DEV_BYPASS: "1", ACCESS_TEAM_DOMAIN: undefined, ACCESS_AUD: undefined });
    const run = async (headers: Record<string, string>) => {
      const context = { get: () => ({ env: dev }), set: () => {} };
      const next = vi.fn(async () => new Response("ran"));
      const request = new Request("http://localhost:5173/admin/brake", { method: "POST", headers });
      const outcome = await Promise.resolve(middleware[0]!({ request, context, params: {} } as never, next as never)).catch(
        (e: unknown) => e,
      );
      return { outcome, ran: next.mock.calls.length > 0 };
    };

    expect((await run({ Origin: "http://localhost:5173" })).ran).toBe(true);
    const crossSite: Record<string, string>[] = [{ Origin: "https://evil.example" }, { Origin: "null" }];
    for (const headers of crossSite) {
      const { outcome, ran } = await run(headers);
      expect(ran).toBe(false);
      expect((outcome as Response).status).toBe(403);
    }
  });
});
