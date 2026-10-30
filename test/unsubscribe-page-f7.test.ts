import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { accounts, emailSuppressions } from "~/db/schema";

import { createInMemoryDb } from "./helpers/inmemory-db";
import { makeRateLimiterNamespace } from "./helpers/rate-limiter";

// Row F7: the /u/:token page against Recova's
// app/api/unsubscribe/route.ts (blob 31de4bc5, read whole). Recova is the spec
// for the states, their copy, the per-IP limit and the layout; Foxhound's engine
// stays (the HMAC token, suppression keyed by address, the RFC 8058 POST, no-store).
//
// Recova's four states and their exact words:
//   no token        "Invalid unsubscribe link."                                    (X)
//   unknown token   "This unsubscribe link is invalid or has expired."             (X)
//   suppressed      "{email} is already unsubscribed."                             (check)
//   newly done      "You've been unsubscribed. You won't receive any more recovery emails." (check)
// and 10 requests per 60 seconds per IP, else 429 "Too many requests". The
// route is u/:token, so Recova's no-token state cannot arise and an absent
// token reads as the invalid state.

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const route = await import("~/routes/utility/unsubscribe");
const { signUnsubscribeToken } = await import("~/lib/email/unsubscribe-token");
const { isSuppressed } = await import("~/lib/email/suppression");

const ACCOUNT = "acct_sample";
const EMAIL = "sam@example.com";

const fakeRateLimiter = () => makeRateLimiterNamespace();

function makeEnv(rateLimiter = fakeRateLimiter()) {
  return { ENCRYPTION_KEY: "a".repeat(64), RATE_LIMITER: rateLimiter } as unknown as Env;
}

const context = (env: Env): unknown => ({
  get: () => ({ env, ctx: {} as ExecutionContext, nonce: "n" }),
});

async function seed() {
  const { db } = createInMemoryDb();
  harness.db = db;
  await db.insert(accounts).values({ id: ACCOUNT, name: "Sample" });
  return db;
}

type LoaderData = Awaited<ReturnType<typeof route.loader>>;

const callLoader = async (env: Env, token: string | undefined): Promise<LoaderData> =>
  route.loader({
    params: { token },
    request: new Request(`https://foxhoundapp.test/u/${token ?? ""}`),
    context: context(env),
  } as never);

/** The page's confirm button, the one visit that writes. */
const confirm = async (env: Env, token: string | undefined) =>
  route.action({
    params: { token },
    request: new Request(`https://foxhoundapp.test/u/${token ?? ""}`, {
      method: "POST",
      body: new URLSearchParams({ confirm: "1" }),
    }),
    context: context(env),
  } as never);

const suppressionRows = async (db: Awaited<ReturnType<typeof seed>>) =>
  db.select().from(emailSuppressions).where(eq(emailSuppressions.email, EMAIL));

// ============================================================================

describe("F7 loader: Recova's four states on Foxhound's engine", () => {

  it("a migrated Recova row with no suppressed_at is suppressed now and records this opt-out", async () => {
    // Recova registered a token row per send with suppressed_at NULL. Such a row
    // conflicts on the address; skipping it would say "already" while mail kept going.
    const db = await seed();
    const env = makeEnv();
    await db.insert(accounts).values({ id: "acct_other", name: "Other" });
    await db.insert(emailSuppressions).values({
      email: EMAIL,
      token: "tok_recova_registered",
      reason: null,
      accountId: "acct_other",
      suppressedAt: null,
    });
    expect(await isSuppressed(env, EMAIL)).toBe(false);
    const token = await signUnsubscribeToken(env, { email: EMAIL, accountId: ACCOUNT });

    expect(await confirm(env, token)).toEqual({ state: "done" });
    const rows = await suppressionRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.suppressedAt).not.toBeNull();
    expect(rows[0]?.reason).toBe("unsubscribe");
    expect(rows[0]?.token).toBe(token);
    expect(rows[0]?.accountId).toBe(ACCOUNT);
    expect(await isSuppressed(env, EMAIL)).toBe(true);
    expect(await confirm(env, token)).toEqual({ state: "already", email: EMAIL });
  });

  it("opening the link writes nothing: a scanner's GET only gets the confirm button", async () => {
    const db = await seed();
    const env = makeEnv();
    const token = await signUnsubscribeToken(env, { email: EMAIL, accountId: ACCOUNT });
    expect(await callLoader(env, token)).toEqual({ state: "confirm" });
    expect(await suppressionRows(db)).toHaveLength(0);
    expect(await isSuppressed(env, EMAIL)).toBe(false);
  });

  it("a tampered or unknown token is the invalid state and writes nothing", async () => {
    const db = await seed();
    const env = makeEnv();
    expect(await callLoader(env, "not-a-token")).toEqual({ state: "invalid" });
    expect(await callLoader(env, " ")).toEqual({ state: "invalid" });
    expect(await confirm(env, "not-a-token")).toEqual({ state: "invalid" });
    expect(await suppressionRows(db)).toHaveLength(0);
  });
});

describe("F7 rate limit: Recova's 10 per 60 seconds per IP on the page", () => {
  const middleware = () => {
    const fns = (route as { middleware?: unknown[] }).middleware;
    expect(Array.isArray(fns), "the route exports a middleware list").toBe(true);
    return (fns as Array<(args: unknown, next: () => Promise<unknown>) => Promise<unknown>>)[0];
  };

  const hit = (env: Env, method = "GET", ip = "203.0.113.7") => {
    const next = vi.fn(async () => new Response("page"));
    const result = middleware()(
      {
        request: new Request("https://foxhoundapp.test/u/tok", {
          method,
          headers: { "cf-connecting-ip": ip },
        }),
        params: { token: "tok" },
        context: context(env),
      },
      next,
    );
    return { result, next };
  };

  it("lets ten GETs through and answers the eleventh 429 'Too many requests' as plain text", async () => {
    const env = makeEnv();
    for (let i = 0; i < 10; i++) {
      const { result, next } = hit(env);
      await result;
      expect(next).toHaveBeenCalledTimes(1);
    }
    const { result, next } = hit(env);
    const res = (await result) as Response;
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toBe(429);
    expect(res.headers.get("Content-Type")).toMatch(/^text\/plain/);
    expect(res.headers.get("Cache-Control")).toMatch(/no-store/);
    expect(await res.text()).toBe("Too many requests");
  });

  it("keys the budget on its own bucket and the caller's IP", async () => {
    const limiter = fakeRateLimiter();
    const env = makeEnv(limiter);
    await hit(env, "GET", "198.51.100.4").result;
    expect(limiter.names).toEqual(["unsubscribe:198.51.100.4"]);
  });

  it("does not spend the budget on the RFC 8058 one-click POST (Recova had no POST)", async () => {
    const limiter = fakeRateLimiter();
    const env = makeEnv(limiter);
    for (let i = 0; i < 12; i++) {
      const { result, next } = hit(env, "POST");
      await result;
      expect(next).toHaveBeenCalledTimes(1);
    }
    expect(limiter.names).toEqual([]);
  });
});
