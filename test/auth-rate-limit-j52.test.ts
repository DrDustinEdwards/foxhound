import { readFileSync } from "node:fs";

import { RouterContextProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cloudflareContext } from "~/lib/cloudflare-context";
import { resolveRateLimitBinding } from "~/lib/http/rate-limit";

import { makeRateLimiterNamespace } from "./helpers/rate-limiter";

// J52 (job_674e728b50a3), row A3 and the sign-in limiter (Q5, Dustin "yes",
// 2026-10-14, message cmsg_01Nd8kh3hkgYNYpWXrNkvBQLC6A6GvHRyQ6YQF4rboRtgK):
// sign-in and signup are limited by site-runtime's limiter, with the limits
// the ledger set. Recova's own numbers, read at lib/constants.ts lines 108 and
// 109: RATE_LIMIT_SIGNUP 5 an hour (ruling 24's bucket) and RATE_LIMIT_LOGIN 10
// a minute, per IP. Foxhound's auth bucket (10 a minute per IP, shared by every
// signed-out POST that tests a password or sends mail) is kept unchanged.
//
// These drive the REAL route actions. The counter is site-runtime's own
// hitRules on a real SQLite database (better-sqlite3), one database per
// Durable Object name, so only the Durable Object's storage is stood in for.
// Better Auth is replaced by counters, so each test can say how many requests
// reached a password check or a mail send.

const harness = vi.hoisted(() => ({
  calls: { signInEmail: 0, signUpEmail: 0, requestPasswordReset: 0, resetPassword: 0, signInSocial: 0, handler: 0 },
  lastBodies: [] as unknown[],
}));

vi.mock("~/lib/auth", async (importOriginal) => {
  const original = await importOriginal<typeof import("~/lib/auth")>();
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  return {
    ...original,
    getAuth: () => ({
      api: {
        signInEmail: async ({ body }: { body: unknown }) => {
          harness.calls.signInEmail++;
          harness.lastBodies.push(body);
          return json(401, { message: "Invalid email or password" });
        },
        signUpEmail: async ({ body }: { body: unknown }) => {
          harness.calls.signUpEmail++;
          harness.lastBodies.push(body);
          return json(200, { token: null });
        },
        requestPasswordReset: async () => {
          harness.calls.requestPasswordReset++;
          return { status: true };
        },
        resetPassword: async () => {
          harness.calls.resetPassword++;
          return json(400, { message: "Invalid token" });
        },
        signInSocial: async () => {
          harness.calls.signInSocial++;
          return json(200, { url: "https://accounts.google.com/o/oauth2/auth" });
        },
      },
      handler: async () => {
        harness.calls.handler++;
        return json(401, { message: "Invalid email or password" });
      },
    }),
  };
});
vi.mock("~/lib/auth/session", () => ({ getSession: async () => null }));

const login = await import("~/routes/auth/login");
const signup = await import("~/routes/auth/signup");
const forgot = await import("~/routes/auth/forgot-password");
const reset = await import("~/routes/auth/reset-password");
const googleStart = await import("~/routes/auth/google-start");
const apiAuth = await import("~/routes/api/auth");

let namespace: ReturnType<typeof makeRateLimiterNamespace>;

function makeEnv(ns: unknown = namespace): Env {
  return {
    AUTH_RATE_LIMITER: ns,
    GOOGLE_CLIENT_ID: "client",
    GOOGLE_CLIENT_SECRET: "secret",
  } as unknown as Env;
}

function context(env: Env) {
  const ctx = new RouterContextProvider();
  ctx.set(cloudflareContext, { env, ctx: {} as ExecutionContext, nonce: "n" });
  return ctx;
}

const PASSWORD = "correct-horse-battery-staple";

function form(path: string, fields: Record<string, string>, ip = "203.0.113.7") {
  return new Request(`https://foxhoundapp.com${path}`, {
    method: "POST",
    headers: { "CF-Connecting-IP": ip, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
}

type ActionModule = { action: (args: never) => unknown };

/** Runs a route's action and returns its status and body, whether it answered
 *  with data(), a Response, or threw a redirect. */
async function run(mod: ActionModule, request: Request, env = makeEnv()) {
  let out: unknown;
  try {
    out = await mod.action({ request, context: context(env), params: {} } as never);
  } catch (thrown) {
    out = thrown;
  }
  if (out instanceof Response) {
    return { status: out.status, headers: out.headers, body: null as Record<string, unknown> | null };
  }
  const d = out as { type?: string; data?: unknown; init?: ResponseInit | null };
  if (d && d.type === "DataWithResponseInit") {
    return {
      status: d.init?.status ?? 200,
      headers: new Headers(d.init?.headers),
      body: d.data as Record<string, unknown>,
    };
  }
  return { status: 200, headers: new Headers(), body: out as Record<string, unknown> };
}

const loginForm = (ip?: string) => form("/login", { email: "a@example.com", password: PASSWORD }, ip);
const signupForm = (ip?: string) => form("/signup", { email: "a@example.com", password: PASSWORD }, ip);

beforeEach(() => {
  namespace = makeRateLimiterNamespace();
  for (const k of Object.keys(harness.calls) as (keyof typeof harness.calls)[]) harness.calls[k] = 0;
  harness.lastBodies.length = 0;
  // Pin the clock to the first second of an hour, so ten requests can never
  // straddle a minute boundary and five can never straddle an hour.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-16T12:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("sign-in: 10 a minute per IP, through the login action", () => {
  it("lets ten attempts reach Better Auth and refuses the eleventh before it does", async () => {
    for (let i = 0; i < 10; i++) {
      const r = await run(login, loginForm());
      expect(r.status, `attempt ${i + 1}`).toBe(400);
    }
    expect(harness.calls.signInEmail).toBe(10);

    const eleventh = await run(login, loginForm());
    expect(eleventh.status).toBe(429);
    expect(harness.calls.signInEmail).toBe(10);
    // Recova's words for a refused sign-in (app/api/auth/login/route.ts line 11),
    // shown in the page's own alert rather than as a bare error page.
    expect(eleventh.body?.error).toBe("Too many attempts. Please try again in a minute.");
    expect(Number(eleventh.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(Number(eleventh.headers.get("Retry-After"))).toBeLessThanOrEqual(60);
  });

  it("counts per IP: another address still signs in", async () => {
    for (let i = 0; i < 11; i++) await run(login, loginForm("203.0.113.7"));
    const other = await run(login, loginForm("198.51.100.9"));
    expect(other.status).toBe(400);
    expect(harness.calls.signInEmail).toBe(11);
  });

  it("opens again in the next minute", async () => {
    for (let i = 0; i < 11; i++) await run(login, loginForm());
    vi.setSystemTime(new Date("2026-10-16T12:01:00.000Z"));
    expect((await run(login, loginForm())).status).toBe(400);
  });

  // The old guard matched the path in workers/app.ts. A hydrated browser posts
  // a form to /login.data (react-router's single fetch adds the suffix), which
  // that matcher never matched, so every sign-in from the page's own form went
  // unthrottled. The action runs whatever URL reached it.
  it("limits the same action when it is reached as /login.data", async () => {
    for (let i = 0; i < 10; i++) await run(login, form("/login.data", { email: "a@example.com", password: PASSWORD }));
    const r = await run(login, form("/login.data", { email: "a@example.com", password: PASSWORD }));
    expect(r.status).toBe(429);
    expect(harness.calls.signInEmail).toBe(10);
  });
});

describe("signup: ruling 24's 5 an hour per IP, through the signup action", () => {
  it("lets five signups reach Better Auth and refuses the sixth", async () => {
    for (let i = 0; i < 5; i++) {
      // A fresh minute each time, so only the hourly bucket can refuse.
      vi.setSystemTime(new Date(Date.UTC(2026, 9, 16, 12, i * 2, 0)));
      expect((await run(signup, signupForm())).status, `signup ${i + 1}`).toBe(200);
    }
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 16, 12, 30, 0)));
    const sixth = await run(signup, signupForm());
    expect(sixth.status).toBe(429);
    // Recova's words (app/api/auth/signup/route.ts line 14).
    expect(sixth.body?.error).toBe("Too many requests. Please try again later.");
    expect(harness.calls.signUpEmail).toBe(5);
    // The hourly window has about half an hour left.
    expect(Number(sixth.headers.get("Retry-After"))).toBeGreaterThan(60);
    expect(Number(sixth.headers.get("Retry-After"))).toBeLessThanOrEqual(1800);
  });

  it("the hourly bucket is signup's own: sign-in from the same IP is not spent by it", async () => {
    for (let i = 0; i < 6; i++) {
      vi.setSystemTime(new Date(Date.UTC(2026, 9, 16, 12, i * 2, 0)));
      await run(signup, signupForm());
    }
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 16, 12, 20, 0)));
    expect((await run(login, loginForm())).status).toBe(400);
  });

  it("closes Better Auth's own sign-up endpoint the same way", async () => {
    const api = () =>
      new Request("https://foxhoundapp.com/api/auth/sign-up/email", {
        method: "POST",
        headers: { "CF-Connecting-IP": "203.0.113.7", "Content-Type": "application/json" },
        body: JSON.stringify({ email: "a@example.com", password: PASSWORD, name: "" }),
      });
    for (let i = 0; i < 5; i++) {
      vi.setSystemTime(new Date(Date.UTC(2026, 9, 16, 12, i * 2, 0)));
      await run(apiAuth, api());
    }
    // The page counts against the same hour.
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 16, 12, 30, 0)));
    expect((await run(signup, signupForm())).status).toBe(429);
    expect((await run(apiAuth, api())).status).toBe(429);
    expect(harness.calls.handler).toBe(5);
  });
});

describe("the shared auth bucket: every signed-out POST that tests a password or sends mail", () => {
  it("is one budget of 10 a minute across the four pages, Google and /api/auth", async () => {
    await run(login, loginForm());
    await run(signup, signupForm());
    await run(forgot, form("/forgot-password", { email: "a@example.com" }));
    await run(reset, form("/reset-password", { token: "t", password: PASSWORD, confirm: PASSWORD }));
    await run(googleStart, form("/auth/google", {}));
    await run(apiAuth, new Request("https://foxhoundapp.com/api/auth/sign-in/email", {
      method: "POST",
      headers: { "CF-Connecting-IP": "203.0.113.7" },
      body: "{}",
    }));
    for (let i = 0; i < 4; i++) await run(login, loginForm());
    // Ten spent. Each surface now refuses before reaching Better Auth.
    const before = { ...harness.calls };
    expect((await run(forgot, form("/forgot-password", { email: "a@example.com" }))).status).toBe(429);
    expect((await run(reset, form("/reset-password", { token: "t", password: PASSWORD, confirm: PASSWORD }))).status).toBe(429);
    // A form post: the refusal goes back to the login page, which says why.
    const google = await run(googleStart, form("/auth/google", {}));
    expect(google.status).toBe(303);
    expect(google.headers.get("Location")).toBe("/login?error=rate_limited");
    expect(
      (await run(apiAuth, new Request("https://foxhoundapp.com/api/auth/sign-in/email", {
        method: "POST",
        headers: { "CF-Connecting-IP": "203.0.113.7" },
        body: "{}",
      }))).status,
    ).toBe(429);
    expect(harness.calls).toEqual(before);
  });

  it("does not count a GET to /api/auth (session reads and verification links)", async () => {
    for (let i = 0; i < 12; i++) {
      const get = new Request("https://foxhoundapp.com/api/auth/get-session", {
        headers: { "CF-Connecting-IP": "203.0.113.7" },
      });
      await apiAuth.loader({ request: get, context: context(makeEnv()), params: {} } as never);
    }
    expect(namespace.names).toEqual([]);
    expect((await run(login, loginForm())).status).toBe(400);
  });

  it("keys on the client address, never on the email or the password", async () => {
    await run(login, loginForm());
    await run(signup, signupForm());
    expect(namespace.names).toEqual(["auth:203.0.113.7", "auth:203.0.113.7", "signup:203.0.113.7"]);
  });
});

describe("a counter that fails lets the request through, by design (RULES.md 4.10)", () => {
  it("signs in when the Durable Object throws, and logs neither the password nor the address", async () => {
    const broken = {
      idFromName: (n: string) => n,
      get: () => ({
        hit: async () => {
          throw new Error("Durable Object unavailable");
        },
      }),
    };
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await run(login, loginForm(), makeEnv(broken));
    expect(r.status).toBe(400);
    expect(harness.calls.signInEmail).toBe(1);
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).toContain("rate-limit-unavailable");
    expect(logged).not.toContain(PASSWORD);
    expect(logged).not.toContain("203.0.113.7");
    log.mockRestore();
  });

  it("signs up when the binding is missing altogether", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await run(signup, signupForm(), makeEnv(undefined));
    expect(r.status).toBe(200);
    expect(harness.calls.signUpEmail).toBe(1);
    log.mockRestore();
  });
});

describe("Foxhound's own limiter no longer handles these paths", () => {
  it("the worker-level matcher leaves every auth POST to the actions", () => {
    for (const path of ["/login", "/signup", "/forgot-password", "/reset-password", "/auth/google", "/api/auth/sign-in/email", "/api/auth"]) {
      expect(resolveRateLimitBinding(new Request(`https://foxhoundapp.com${path}`, { method: "POST" })), path).toBeNull();
    }
  });

  it("the routes import the limiter from site-runtime, not from app/lib/http/rate-limit", () => {
    const src = readFileSync("app/lib/auth/rate-limit.server.ts", "utf8");
    expect(src).toContain('from "@dustinedwards/site-runtime/rate-limit"');
    for (const f of ["login.tsx", "signup.tsx", "forgot-password.tsx", "reset-password.tsx", "google-start.ts"]) {
      const route = readFileSync(`app/routes/auth/${f}`, "utf8");
      expect(route, f).toContain("~/lib/auth/rate-limit.server");
      expect(route, f).not.toContain("~/lib/http/rate-limit");
    }
  });

  it("binds site-runtime's Durable Object class and exports it from the Worker", () => {
    const wrangler = readFileSync("wrangler.jsonc", "utf8").replace(/\/\/[^\n]*/g, "");
    expect(wrangler).toMatch(/"name":\s*"AUTH_RATE_LIMITER",\s*"class_name":\s*"RateLimiter"/);
    expect(wrangler).toMatch(/"RateLimiter":\s*\{\s*"type":\s*"durable-object",\s*"storage":\s*"sqlite"\s*\}/);
    expect(readFileSync("workers/app.ts", "utf8")).toContain(
      'export { RateLimiter } from "@dustinedwards/site-runtime/rate-limit/durable-object";',
    );
  });
});
