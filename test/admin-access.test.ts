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
  it("accepts a valid assertion for an allowlisted email, from the header", async () => {
    stubKeys();
    const jwt = await token({ email: "Admin@Example.com" });
    expect(await getAdminSession(env(), request({ "Cf-Access-Jwt-Assertion": jwt }))).toEqual({ email: ADMIN });
  });

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

  it("fails closed when the team domain or AUD is unset", async () => {
    stubKeys();
    const jwt = await token({ email: ADMIN });
    const headers = { "Cf-Access-Jwt-Assertion": jwt };
    expect(await getAdminSession(env({ ACCESS_TEAM_DOMAIN: undefined }), request(headers))).toBeNull();
    expect(await getAdminSession(env({ ACCESS_AUD: undefined }), request(headers))).toBeNull();
  });

  it("the dev bypass works on localhost only", async () => {
    const dev = env({ ACCESS_DEV_BYPASS: "1", ACCESS_TEAM_DOMAIN: undefined, ACCESS_AUD: undefined });
    expect(await getAdminSession(dev, request({}, "http://localhost:5173/admin"))).toEqual({ email: ADMIN });
    expect(await getAdminSession(dev, request({}, "https://foxhoundapp.com/admin"))).toBeNull();
  });
});
