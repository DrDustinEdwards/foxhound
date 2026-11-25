import { describe, expect, it, vi } from "vitest";

import { limitPublicActions, resolveRateLimitBinding } from "~/lib/http/rate-limit";

import { makeRateLimiterNamespace } from "./helpers/rate-limiter";

// Foxhound's matcher and wrapper over site-runtime's limiter (counted in its own tests),
// driven through a fake namespace that runs site-runtime's hitRules on SQLite.

function makeEnv(namespace: unknown = makeRateLimiterNamespace()) {
  return { RATE_LIMITER: namespace } as unknown as Env;
}

const broken = {
  idFromName: (name: string) => name,
  get: () => ({ hit: () => Promise.reject(new Error("DO unavailable")) }),
};

const PUBLIC_RULE = { bucket: "public", limit: 20, periodMs: 60_000 };

function post(path: string) {
  return new Request(`http://localhost${path}`, { method: "POST" });
}

// These actions are limited by site-runtime's limiter inside the action, so the
// matcher must resolve no rule for them (the two limiters never both count one request).
const IN_PROCESS_AUTH_POSTS = ["/login", "/signup", "/auth/google", "/auth/apple"];

describe("resolveRateLimitBinding", () => {
  it.each(IN_PROCESS_AUTH_POSTS)("leaves POST %s to its action's limiter", (path) => {
    expect(resolveRateLimitBinding(post(path))).toBeNull();
  });

  it("leaves POST /api/auth/*, session-only POSTs and webhooks alone", () => {
    for (const path of [
      "/api/auth/sign-in/magic-link",
      "/api/auth",
      "/connect",
      "/invite/tok_abc123",
      "/webhooks/stripe",
    ]) {
      expect(resolveRateLimitBinding(post(path)), path).toBeNull();
    }
  });

  it("matches POST /demos and /audit to the public bucket, and not GET", () => {
    expect(resolveRateLimitBinding(post("/demos"))).toEqual(PUBLIC_RULE);
    expect(resolveRateLimitBinding(post("/audit"))).toEqual(PUBLIC_RULE);
    expect(
      resolveRateLimitBinding(new Request("http://localhost/demos", { method: "GET" })),
    ).toBeNull();
  });

  it("leaves POST /logout alone, in every spelling the router would route", () => {
    for (const path of ["/logout", "/LOGOUT", "/logout/", "/logout///", "/%6Cogout"]) {
      expect(resolveRateLimitBinding(post(path))).toBeNull();
    }
  });

  it("does not fire on paths that merely start with a limited path's letters", () => {
    for (const path of ["/loginx", "/audits", "/demos-2", "/auth/googlebot"]) {
      expect(resolveRateLimitBinding(post(path))).toBeNull();
    }
  });

  // The router matches a different string than URL.pathname reports: an equality
  // test on the raw pathname would let each of these spellings through unthrottled.
  it("normalizes the way the router does, so a spelling cannot bypass the limit", () => {
    for (const path of ["/DEMOS", "/Audit", "/demos///", "/audit/", "/%64emos", "/%44EMOS///"]) {
      expect(resolveRateLimitBinding(post(path)), path).toEqual(PUBLIC_RULE);
    }
    // An encoded separator stays encoded, as the router re-escapes it, and a bad escape never throws.
    for (const path of ["/%2Fdemos", "/%E0%A4%A", "/demos%"]) {
      expect(resolveRateLimitBinding(post(path)), path).toBeNull();
    }
  });
});

describe("limitPublicActions", () => {
  it("allows the first 20 public requests for a key and denies the 21st with 429", async () => {
    const env = makeEnv();
    const ip = { "cf-connecting-ip": "1.2.3.4" };
    for (let i = 1; i <= 20; i++) {
      const req = new Request("http://localhost/demos", { method: "POST", headers: ip });
      expect(await limitPublicActions(req, env)).toBeNull();
    }
    const over = new Request("http://localhost/demos", { method: "POST", headers: ip });
    const result = await limitPublicActions(over, env);
    expect(result?.status).toBe(429);
    expect(result?.headers.get("Retry-After")).toMatch(/^\d+$/);
  });

  it("fails open when the Durable Object call throws", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const request = new Request("http://localhost/demos", {
      method: "POST",
      headers: { "cf-connecting-ip": "1.1.1.1" },
    });
    await expect(limitPublicActions(request, makeEnv(broken))).resolves.toBeNull();
    log.mockRestore();
  });
});
