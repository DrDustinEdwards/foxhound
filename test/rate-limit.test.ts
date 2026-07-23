import { describe, expect, it, vi } from "vitest";

import { checkRateLimitWindow, type RateLimitWindow } from "~/lib/http/rate-limit-window";
import {
  enforceRateLimit,
  isWithinRateLimit,
  rateLimitedResponse,
  resolveRateLimitBinding,
} from "~/lib/http/rate-limit";

// audit finding M-1 (foxhound-audit-security.md): /api/auth/* was
// live-verified unthrottled (8 rapid sign-in POSTs, no 429). Originally
// tested against a mock Cloudflare RateLimit binding
// (TASK-foxhound-auth-rate-limit.md); that binding was replaced with a
// Durable Object we own after it proved untrustworthy live in production
// (TASK-foxhound-do-rate-limiter.md). enforceRateLimit's DO calls below run
// through the REAL checkRateLimitWindow algorithm via a fake
// DurableObjectNamespace (same code path as production, only the storage
// backing - real DO SQLite vs. an in-memory map keyed by idFromName - is
// faked), so this is not a dumb stub of the outcome.

/** A fake DurableObjectNamespace: same idFromName -> same instance and
 *  storage, different idFromName -> fully isolated storage, exactly like a
 *  real DurableObjectNamespace. Each stub's check() runs the real window
 *  algorithm. */
function makeFakeRateLimiterNamespace() {
  const storage = new Map<string, RateLimitWindow | undefined>();
  const idFromName = vi.fn((name: string) => name);
  const get = vi.fn((id: string) => ({
    check: (limit: number, periodMs: number) =>
      checkRateLimitWindow(
        {
          getWindow: async () => storage.get(id),
          putWindow: async (w) => {
            storage.set(id, w);
          },
        },
        Date.now(),
        limit,
        periodMs,
      ),
  }));
  return { idFromName, get };
}

function makeEnv(namespace = makeFakeRateLimiterNamespace()) {
  return { RATE_LIMITER: namespace } as unknown as Env;
}

describe("resolveRateLimitBinding", () => {
  it("matches POST /api/auth/* to the auth bucket (10/60s)", () => {
    const request = new Request("http://localhost/api/auth/sign-in/email", { method: "POST" });
    expect(resolveRateLimitBinding(request)).toEqual({ bucket: "auth", limit: 10, periodMs: 60_000 });
  });

  it("matches POST /demos to the public bucket (20/60s)", () => {
    const request = new Request("http://localhost/demos", { method: "POST" });
    expect(resolveRateLimitBinding(request)).toEqual({ bucket: "public", limit: 20, periodMs: 60_000 });
  });

  it("matches POST /audit to the public bucket (20/60s)", () => {
    const request = new Request("http://localhost/audit", { method: "POST" });
    expect(resolveRateLimitBinding(request)).toEqual({ bucket: "public", limit: 20, periodMs: 60_000 });
  });

  it("does not rate-limit GET /api/auth/* (session checks, verification links)", () => {
    const request = new Request("http://localhost/api/auth/get-session", { method: "GET" });
    expect(resolveRateLimitBinding(request)).toBeNull();
  });

  it("does not rate-limit GET /demos or GET /audit (page renders)", () => {
    expect(resolveRateLimitBinding(new Request("http://localhost/demos", { method: "GET" }))).toBeNull();
    expect(resolveRateLimitBinding(new Request("http://localhost/audit", { method: "GET" }))).toBeNull();
  });

  it("does not rate-limit unrelated routes, including other POST surfaces like webhooks", () => {
    expect(
      resolveRateLimitBinding(new Request("http://localhost/webhooks/stripe", { method: "POST" })),
    ).toBeNull();
    expect(resolveRateLimitBinding(new Request("http://localhost/login", { method: "POST" }))).toBeNull();
  });
});

describe("rateLimitedResponse", () => {
  it("returns 429 with a Retry-After header and JSON body", async () => {
    const res = rateLimitedResponse(45);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("45");
    expect(res.headers.get("Content-Type")).toBe("application/json");
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/too many requests/i);
  });
});

describe("enforceRateLimit", () => {
  it("returns null (proceed) for a route with no matching rule", async () => {
    const env = makeEnv();
    const request = new Request("http://localhost/pricing", { method: "GET" });
    expect(await enforceRateLimit(request, env)).toBeNull();
  });

  it("allows the first 10 auth requests for a key and denies the 11th with 429", async () => {
    const env = makeEnv();
    const ip = { "cf-connecting-ip": "1.2.3.4" };
    for (let i = 1; i <= 10; i++) {
      const req = new Request("http://localhost/api/auth/sign-in/email", { method: "POST", headers: ip });
      expect(await enforceRateLimit(req, env)).toBeNull();
    }
    const eleventh = new Request("http://localhost/api/auth/sign-in/email", { method: "POST", headers: ip });
    const result = await enforceRateLimit(eleventh, env);
    expect(result).not.toBeNull();
    expect(result?.status).toBe(429);
    expect(result?.headers.get("Retry-After")).toMatch(/^\d+$/);
  });

  it("keys the DO id on bucket + cf-connecting-ip", async () => {
    const namespace = makeFakeRateLimiterNamespace();
    const env = makeEnv(namespace);
    const request = new Request("http://localhost/api/auth/sign-in/email", {
      method: "POST",
      headers: { "cf-connecting-ip": "9.8.7.6" },
    });
    await enforceRateLimit(request, env);
    expect(namespace.idFromName).toHaveBeenCalledWith("auth:9.8.7.6");
  });

  it("falls back to a stable key when cf-connecting-ip is absent", async () => {
    const namespace = makeFakeRateLimiterNamespace();
    const env = makeEnv(namespace);
    const request = new Request("http://localhost/api/auth/sign-in/email", { method: "POST" });
    await enforceRateLimit(request, env);
    expect(namespace.idFromName).toHaveBeenCalledWith("auth:unknown");
  });

  it("bucket isolation: exhausting the auth bucket leaves the public bucket untouched for the same IP", async () => {
    const namespace = makeFakeRateLimiterNamespace();
    const env = makeEnv(namespace);
    const ip = { "cf-connecting-ip": "5.5.5.5" };

    for (let i = 1; i <= 11; i++) {
      const req = new Request("http://localhost/api/auth/sign-in/email", { method: "POST", headers: ip });
      await enforceRateLimit(req, env);
    }
    const authRetry = await enforceRateLimit(
      new Request("http://localhost/api/auth/sign-in/email", { method: "POST", headers: ip }),
      env,
    );
    expect(authRetry?.status).toBe(429); // auth bucket is exhausted for this IP

    const demosReq = new Request("http://localhost/demos", { method: "POST", headers: ip });
    expect(await enforceRateLimit(demosReq, env)).toBeNull(); // public bucket, same IP, untouched
  });

  it("fails open when the Durable Object call throws", async () => {
    const namespace = {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn(() => ({
        check: vi.fn().mockRejectedValue(new Error("DO unavailable")),
      })),
    };
    const env = makeEnv(namespace);
    const request = new Request("http://localhost/api/auth/sign-in/email", {
      method: "POST",
      headers: { "cf-connecting-ip": "1.1.1.1" },
    });
    await expect(enforceRateLimit(request, env)).resolves.toBeNull();
  });
});

describe("isWithinRateLimit", () => {
  it("allows the first N calls for a key and denies the (N+1)th", async () => {
    const env = makeEnv();
    for (let i = 1; i <= 3; i++) {
      expect(await isWithinRateLimit(env, "marketing_email_sample", "8.8.8.8", 3, 60_000)).toBe(true);
    }
    expect(await isWithinRateLimit(env, "marketing_email_sample", "8.8.8.8", 3, 60_000)).toBe(false);
  });

  it("isolates by bucket, so a different bucket for the same key is untouched", async () => {
    const namespace = makeFakeRateLimiterNamespace();
    const env = makeEnv(namespace);
    for (let i = 1; i <= 3; i++) {
      await isWithinRateLimit(env, "marketing_email_sample", "8.8.8.8", 3, 60_000);
    }
    expect(await isWithinRateLimit(env, "marketing_email_sample", "8.8.8.8", 3, 60_000)).toBe(false);
    expect(await isWithinRateLimit(env, "public", "8.8.8.8", 20, 60_000)).toBe(true);
  });

  it("fails open when the Durable Object call throws", async () => {
    const namespace = {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn(() => ({
        check: vi.fn().mockRejectedValue(new Error("DO unavailable")),
      })),
    };
    const env = makeEnv(namespace);
    await expect(isWithinRateLimit(env, "marketing_email_sample", "1.1.1.1", 10, 60_000)).resolves.toBe(true);
  });
});
