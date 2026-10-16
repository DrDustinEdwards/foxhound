import { describe, expect, it, vi } from "vitest";

import { checkRateLimitWindow, type RateLimitWindow } from "~/lib/http/rate-limit-window";
import {
  enforceRateLimit,
  isWithinRateLimit,
  RateLimiterUnavailableError,
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

const PUBLIC_RULE = { bucket: "public", limit: 20, periodMs: 60_000 };

function post(path: string) {
  return new Request(`http://localhost${path}`, { method: "POST" });
}

// J52: these paths left this matcher for site-runtime's limiter inside their
// actions (app/lib/auth/rate-limit.server.ts, test/auth-rate-limit-j52.test.ts).
// They are kept here as the list that must now resolve to no rule, so the two
// limiters can never both count one request.
//
// Ruling 376 item (1): the matcher covered POST /api/auth/ only, while every
// sign-in, sign-up and reset POST goes to its OWN route and calls Better Auth
// in-process, so the Durable Object never saw one. Each row below is a path
// whose action reaches a Better Auth credential or mail method, named with the
// method it reaches, so a future reader can check the row against the route
// rather than trusting this list.
const IN_PROCESS_AUTH_POSTS = [
  ["/login", "api.signInEmail"],
  ["/signup", "api.signUpEmail"],
  ["/forgot-password", "api.requestPasswordReset"],
  ["/reset-password", "api.resetPassword"],
  ["/auth/google", "api.signInSocial"],
] as const;

describe("resolveRateLimitBinding", () => {
  it.each(IN_PROCESS_AUTH_POSTS)("leaves POST %s (%s) to its action's limiter", (path) => {
    expect(resolveRateLimitBinding(post(path))).toBeNull();
  });

  it.each(IN_PROCESS_AUTH_POSTS)("does not rate-limit GET %s (%s renders a form)", (path) => {
    expect(
      resolveRateLimitBinding(new Request(`http://localhost${path}`, { method: "GET" })),
    ).toBeNull();
  });

  it("leaves POST /api/auth/* and /api/auth to the splat route's action", () => {
    expect(resolveRateLimitBinding(post("/api/auth/sign-in/email"))).toBeNull();
    expect(resolveRateLimitBinding(post("/api/auth"))).toBeNull();
  });

  it("matches POST /demos to the public bucket (20/60s)", () => {
    expect(resolveRateLimitBinding(post("/demos"))).toEqual(PUBLIC_RULE);
  });

  it("matches POST /audit to the public bucket (20/60s)", () => {
    expect(resolveRateLimitBinding(post("/audit"))).toEqual(PUBLIC_RULE);
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
    expect(resolveRateLimitBinding(post("/webhooks/stripe"))).toBeNull();
    expect(resolveRateLimitBinding(post("/webhooks/stripe-platform"))).toBeNull();
  });

  // THE INNOCENT CASES. A guard that fires on traffic it has no business
  // touching gets deleted rather than fixed (capsid/conventions.md), and
  // widening a matcher is exactly when that happens. /connect and
  // /invite/:token are the near misses on purpose: both are POST actions under
  // app/routes/auth, both reach getAuth(env).api, and both reach only
  // getSession, which is the read every authenticated loader performs.
  it("leaves session-only auth POSTs alone: /connect and /invite/:token", () => {
    expect(resolveRateLimitBinding(post("/connect"))).toBeNull();
    expect(resolveRateLimitBinding(post("/connect/additional"))).toBeNull();
    expect(resolveRateLimitBinding(post("/invite/tok_abc123"))).toBeNull();
  });

  // /logout IS THE THIRD INNOCENT CASE, and it moved here from the throttled
  // table above. It reaches api.signOut, so unlike /connect and /invite it does
  // clear the "calls a Better Auth method" bar; it fails the one that matters.
  // Signing out tests no credential and sends no mail, and the bucket is
  // per-IP, so throttling it would let a shared-IP team spend on logouts the
  // budget their next sign-in needs. Ruling 378 call (a) took it out.
  //
  // Asserted null on every spelling the normalizer folds, so the exclusion
  // cannot be quietly undone by the matcher widening around it.
  it("leaves POST /logout alone, in every spelling the router would route", () => {
    for (const path of ["/logout", "/LOGOUT", "/logout/", "/logout///", "/%6Cogout"]) {
      expect(resolveRateLimitBinding(post(path))).toBeNull();
    }
  });

  it("does not fire on paths that merely start with an auth path's letters", () => {
    for (const path of ["/loginx", "/signups", "/logout-all", "/auth/googlebot", "/audits", "/demos-2"]) {
      expect(resolveRateLimitBinding(post(path))).toBeNull();
    }
  });

  it("does not fire on ordinary app POSTs", () => {
    for (const path of ["/dashboard", "/api/theme", "/api/account/switch", "/settings/email"]) {
      expect(resolveRateLimitBinding(post(path))).toBeNull();
    }
  });

  // THE ROUTER MATCHES A DIFFERENT STRING THAN URL.pathname REPORTS. Each
  // spelling below was driven through matchRoutes against the installed
  // react-router 8.2.0 and lands on the auth action; an equality test on the
  // raw pathname lets all of them through unthrottled.
  describe("normalizes the way the router does, so a bypass by spelling cannot work", () => {
    it("folds case, because compilePath's regexp is case-insensitive by default", () => {
      expect(resolveRateLimitBinding(post("/DEMOS"))).toEqual(PUBLIC_RULE);
      expect(resolveRateLimitBinding(post("/Audit"))).toEqual(PUBLIC_RULE);
    });

    it("folds trailing slashes, because compilePath terminates the pattern with a slash-star", () => {
      expect(resolveRateLimitBinding(post("/demos///"))).toEqual(PUBLIC_RULE);
      expect(resolveRateLimitBinding(post("/audit/"))).toEqual(PUBLIC_RULE);
    });

    it("decodes percent-escapes, because matchRoutes matches on decodePath output", () => {
      expect(resolveRateLimitBinding(post("/%64emos"))).toEqual(PUBLIC_RULE);
      expect(resolveRateLimitBinding(post("/au%64it"))).toEqual(PUBLIC_RULE);
    });

    it("keeps an encoded separator encoded, exactly as decodePath re-escapes it", () => {
      // decodePath turns a decoded "/" back into %2F so a segment cannot
      // smuggle a separator. The limiter agrees, which is what keeps it from
      // being STRICTER than the router.
      expect(resolveRateLimitBinding(post("/%2Fdemos"))).toBeNull();
    });

    it("survives a malformed percent-escape instead of throwing", () => {
      // decodePath catches and falls back to the raw value; so does routedPath.
      expect(resolveRateLimitBinding(post("/%E0%A4%A"))).toBeNull();
      expect(resolveRateLimitBinding(post("/demos%"))).toBeNull();
    });

    // THE FIXTURE THE PRODUCTION PATH CANNOT PRODUCE (ruling 371 binding 5).
    // It resolves to the public bucket only if decoding, case folding and
    // slash folding ALL run. The auth spellings this used to carry (/%4COGIN///)
    // are the actions' to refuse now (J52), which no spelling can avoid.
    it("throttles a spelling only an attacker would send: /%44EMOS///", () => {
      expect(resolveRateLimitBinding(post("/%44EMOS///"))).toEqual(PUBLIC_RULE);
    });
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

  it("allows the first 20 public requests for a key and denies the 21st with 429", async () => {
    const env = makeEnv();
    const ip = { "cf-connecting-ip": "1.2.3.4" };
    for (let i = 1; i <= 20; i++) {
      const req = new Request("http://localhost/demos", { method: "POST", headers: ip });
      expect(await enforceRateLimit(req, env)).toBeNull();
    }
    const over = new Request("http://localhost/demos", { method: "POST", headers: ip });
    const result = await enforceRateLimit(over, env);
    expect(result).not.toBeNull();
    expect(result?.status).toBe(429);
    expect(result?.headers.get("Retry-After")).toMatch(/^\d+$/);
  });

  it("keys the DO id on bucket + cf-connecting-ip", async () => {
    const namespace = makeFakeRateLimiterNamespace();
    const env = makeEnv(namespace);
    const request = new Request("http://localhost/audit", {
      method: "POST",
      headers: { "cf-connecting-ip": "9.8.7.6" },
    });
    await enforceRateLimit(request, env);
    expect(namespace.idFromName).toHaveBeenCalledWith("public:9.8.7.6");
  });

  it("falls back to a stable key when cf-connecting-ip is absent", async () => {
    const namespace = makeFakeRateLimiterNamespace();
    const env = makeEnv(namespace);
    const request = new Request("http://localhost/audit", { method: "POST" });
    await enforceRateLimit(request, env);
    expect(namespace.idFromName).toHaveBeenCalledWith("public:unknown");
  });

  it("never touches the counter for an auth POST, which its action counts", async () => {
    const namespace = makeFakeRateLimiterNamespace();
    const env = makeEnv(namespace);
    for (const path of ["/login", "/signup", "/api/auth/sign-in/email"]) {
      const req = new Request(`http://localhost${path}`, { method: "POST", headers: { "cf-connecting-ip": "5.5.5.5" } });
      expect(await enforceRateLimit(req, env)).toBeNull();
    }
    expect(namespace.idFromName).not.toHaveBeenCalled();
  });

  it("fails open when the Durable Object call throws", async () => {
    const namespace = {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn(() => ({
        check: vi.fn().mockRejectedValue(new Error("DO unavailable")),
      })),
    };
    const env = makeEnv(namespace);
    const request = new Request("http://localhost/demos", {
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

  // J67 review: a caller whose request costs money (the Intelligence report
  // button's paid model call) opts in to failing closed. The error is logged
  // whole and thrown as RateLimiterUnavailableError, so the caller can refuse
  // and say why instead of calling it a rate limit.
  it("fails closed, logging the whole error, when the caller opts in", async () => {
    const cause = new Error("DO unavailable");
    const namespace = {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn(() => ({ check: vi.fn().mockRejectedValue(cause) })),
    };
    const env = makeEnv(namespace);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      isWithinRateLimit(env, "intelligence-report", "acc_1", 5, 3_600_000, { failClosed: true }),
    ).rejects.toBeInstanceOf(RateLimiterUnavailableError);
    expect(log.mock.calls.some((call) => call.includes(cause))).toBe(true);
    log.mockRestore();
  });

  it("is unchanged by the fail-closed option when the Durable Object answers", async () => {
    const env = makeEnv();
    for (let i = 0; i < 2; i++) {
      expect(await isWithinRateLimit(env, "intelligence-report", "acc_1", 2, 60_000, { failClosed: true })).toBe(true);
    }
    expect(await isWithinRateLimit(env, "intelligence-report", "acc_1", 2, 60_000, { failClosed: true })).toBe(false);
  });
});
