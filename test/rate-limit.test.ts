import { describe, expect, it, vi } from "vitest";

import {
  enforceRateLimit,
  rateLimitedResponse,
  resolveRateLimitBinding,
} from "~/lib/http/rate-limit";

// audit finding M-1 (foxhound-audit-security.md): /api/auth/* was
// live-verified unthrottled (8 rapid sign-in POSTs, no 429). These tests
// mock the RateLimit binding rather than requiring a live Workers rate
// limiter, per TASK-foxhound-auth-rate-limit.md.

function mockBinding(success: boolean) {
  return { limit: vi.fn().mockResolvedValue({ success }) };
}

function makeEnv(overrides: Partial<{ RATE_LIMIT_AUTH: RateLimit; RATE_LIMIT_PUBLIC: RateLimit }> = {}) {
  return {
    RATE_LIMIT_AUTH: mockBinding(true),
    RATE_LIMIT_PUBLIC: mockBinding(true),
    ...overrides,
  } as unknown as Env;
}

describe("resolveRateLimitBinding", () => {
  it("matches POST /api/auth/* to RATE_LIMIT_AUTH", () => {
    const env = makeEnv();
    const request = new Request("http://localhost/api/auth/sign-in/email", { method: "POST" });
    expect(resolveRateLimitBinding(request, env)).toBe(env.RATE_LIMIT_AUTH);
  });

  it("matches POST /demos to RATE_LIMIT_PUBLIC", () => {
    const env = makeEnv();
    const request = new Request("http://localhost/demos", { method: "POST" });
    expect(resolveRateLimitBinding(request, env)).toBe(env.RATE_LIMIT_PUBLIC);
  });

  it("matches POST /audit to RATE_LIMIT_PUBLIC", () => {
    const env = makeEnv();
    const request = new Request("http://localhost/audit", { method: "POST" });
    expect(resolveRateLimitBinding(request, env)).toBe(env.RATE_LIMIT_PUBLIC);
  });

  it("does not rate-limit GET /api/auth/* (session checks, verification links)", () => {
    const env = makeEnv();
    const request = new Request("http://localhost/api/auth/get-session", { method: "GET" });
    expect(resolveRateLimitBinding(request, env)).toBeNull();
  });

  it("does not rate-limit GET /demos or GET /audit (page renders)", () => {
    const env = makeEnv();
    expect(
      resolveRateLimitBinding(new Request("http://localhost/demos", { method: "GET" }), env),
    ).toBeNull();
    expect(
      resolveRateLimitBinding(new Request("http://localhost/audit", { method: "GET" }), env),
    ).toBeNull();
  });

  it("does not rate-limit unrelated routes, including other POST surfaces like webhooks", () => {
    const env = makeEnv();
    expect(
      resolveRateLimitBinding(new Request("http://localhost/webhooks/stripe", { method: "POST" }), env),
    ).toBeNull();
    expect(
      resolveRateLimitBinding(new Request("http://localhost/login", { method: "POST" }), env),
    ).toBeNull();
  });
});

describe("rateLimitedResponse", () => {
  it("returns 429 with a Retry-After header and JSON body", async () => {
    const res = rateLimitedResponse(60);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(res.headers.get("Content-Type")).toBe("application/json");
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/too many requests/i);
  });
});

describe("enforceRateLimit", () => {
  it("returns null (proceed) for a route with no matching binding", async () => {
    const env = makeEnv();
    const request = new Request("http://localhost/pricing", { method: "GET" });
    expect(await enforceRateLimit(request, env)).toBeNull();
  });

  it("returns null (proceed) when the binding reports success (under budget)", async () => {
    const env = makeEnv({ RATE_LIMIT_AUTH: mockBinding(true) });
    const request = new Request("http://localhost/api/auth/sign-in/email", {
      method: "POST",
      headers: { "cf-connecting-ip": "1.2.3.4" },
    });
    expect(await enforceRateLimit(request, env)).toBeNull();
  });

  it("returns a 429 when the binding reports failure (over budget)", async () => {
    const env = makeEnv({ RATE_LIMIT_AUTH: mockBinding(false) });
    const request = new Request("http://localhost/api/auth/sign-in/email", {
      method: "POST",
      headers: { "cf-connecting-ip": "1.2.3.4" },
    });
    const result = await enforceRateLimit(request, env);
    expect(result).not.toBeNull();
    expect(result?.status).toBe(429);
    expect(result?.headers.get("Retry-After")).toBe("60");
  });

  it("keys the binding call on cf-connecting-ip", async () => {
    const binding = mockBinding(true);
    const env = makeEnv({ RATE_LIMIT_AUTH: binding });
    const request = new Request("http://localhost/api/auth/sign-in/email", {
      method: "POST",
      headers: { "cf-connecting-ip": "9.8.7.6" },
    });
    await enforceRateLimit(request, env);
    expect(binding.limit).toHaveBeenCalledWith({ key: "9.8.7.6" });
  });

  it("falls back to a stable key when cf-connecting-ip is absent", async () => {
    const binding = mockBinding(true);
    const env = makeEnv({ RATE_LIMIT_AUTH: binding });
    const request = new Request("http://localhost/api/auth/sign-in/email", { method: "POST" });
    await enforceRateLimit(request, env);
    expect(binding.limit).toHaveBeenCalledWith({ key: "unknown" });
  });

  it("does not call the public binding when the auth binding is the match", async () => {
    const authBinding = mockBinding(true);
    const publicBinding = mockBinding(true);
    const env = makeEnv({ RATE_LIMIT_AUTH: authBinding, RATE_LIMIT_PUBLIC: publicBinding });
    const request = new Request("http://localhost/api/auth/sign-in/email", { method: "POST" });
    await enforceRateLimit(request, env);
    expect(authBinding.limit).toHaveBeenCalledTimes(1);
    expect(publicBinding.limit).not.toHaveBeenCalled();
  });
});
