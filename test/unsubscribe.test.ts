import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { accounts, emailSuppressions } from "~/db/schema";
import * as schema from "~/db/schema";
import { buildSuppressionInsert } from "~/lib/email/events";
import { UNSUBSCRIBE_REASON } from "~/lib/email/suppression";

import { createInMemoryDb } from "./helpers/inmemory-db";
import { makeRateLimiterNamespace } from "./helpers/rate-limiter";

// The /u/:token unsubscribe page: signed token, idempotent suppression write, per-IP limit.

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const route = await import("~/routes/utility/unsubscribe");
const { signUnsubscribeToken } = await import("~/lib/email/unsubscribe-token");
const { SendGates } = await import("~/lib/email/dispatch");
const isSuppressed = async (env: Env, to: string) =>
  (await SendGates.read(env, [{ to, accountId: null }])).suppressed({ to, accountId: null });

const ACCOUNT = "acct_sample";
const EMAIL = "sam@example.com";

const fakeRateLimiter = () => makeRateLimiterNamespace();

function makeEnv(rateLimiter = fakeRateLimiter()) {
  return { ENCRYPTION_KEY: "a".repeat(64), RATE_LIMITER: rateLimiter } as unknown as Env;
}

const context = (env: Env): unknown => ({
  get: () => ({ env, ctx: {} as ExecutionContext }),
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

describe("the /u/:token page", () => {
  it("a migrated row with no suppressed_at is suppressed now and records this opt-out", async () => {
    // A migrated row with suppressed_at NULL conflicts on the address; skipping it would say
    // "already" while mail kept going.
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

describe("the page is rate limited per IP", () => {
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

  it("does not spend the budget on the RFC 8058 one-click POST", async () => {
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

const now = new Date("2026-07-21T00:00:00.000Z");

describe("unsubscribe suppression write (real sqlite)", () => {
  const insertUnsub = (db: ReturnType<typeof createInMemoryDb>["db"], token: string) =>
    buildSuppressionInsert(db, {
      email: "cust@example.com",
      token,
      reason: UNSUBSCRIBE_REASON,
      accountId: "acc_1",
      now,
    });

  it("is idempotent: a second click is a no-op, not a duplicate or an error", async () => {
    const { db } = createInMemoryDb();
    await db.insert(schema.accounts).values({ id: "acc_1", name: "Acme" });

    await insertUnsub(db, "tok_1");
    await insertUnsub(db, "tok_1"); // same link followed twice
    await insertUnsub(db, "tok_2"); // or a List-Unsubscribe POST after the GET

    const rows = await db
      .select()
      .from(schema.emailSuppressions)
      .where(eq(schema.emailSuppressions.email, "cust@example.com"));
    expect(rows).toHaveLength(1);
  });

  it("matches the address in any case, and a bounce suppresses a migrated unsuppressed row", async () => {
    const { db } = createInMemoryDb();
    await db.insert(schema.accounts).values({ id: "acc_1", name: "Acme" });
    await db.insert(schema.emailSuppressions).values({
      email: "migrated@example.com",
      token: "tok_m",
      reason: null,
      accountId: "acc_1",
      suppressedAt: null,
    });
    await db.insert(schema.emailSuppressions).values({
      email: "Legacy@Example.com",
      token: "tok_l",
      reason: "unsubscribe",
      accountId: "acc_1",
      suppressedAt: now,
    });
    await buildSuppressionInsert(db, {
      email: "Migrated@Example.com",
      token: "tok_b",
      reason: "bounce",
      accountId: "acc_1",
      now,
    });
    harness.db = db;
    const env = makeEnv();
    const gates = await SendGates.read(env, [
      { to: "migrated@example.com", accountId: null },
      { to: "legacy@example.com", accountId: null },
    ]);
    expect(gates.suppressed({ to: "migrated@example.com", accountId: null })).toBe(true);
    expect(gates.suppressed({ to: "legacy@example.com", accountId: null })).toBe(true);
  });
});

describe("the link signing key (EMAIL_TOKEN_KEY, falling back to ENCRYPTION_KEY)", () => {
  it("signs with EMAIL_TOKEN_KEY once set, and a link signed before it still verifies", async () => {
    const { signUnsubscribeToken, verifyUnsubscribeToken } =
      await import("~/lib/email/unsubscribe-token");
    const payload = { email: "cust@example.com", accountId: "acc_1" };
    const before = { ENCRYPTION_KEY: "a".repeat(64) } as unknown as Env;
    const after = {
      ENCRYPTION_KEY: "a".repeat(64),
      EMAIL_TOKEN_KEY: "b".repeat(64),
    } as unknown as Env;
    const emailKeyOnly = {
      ENCRYPTION_KEY: "c".repeat(64),
      EMAIL_TOKEN_KEY: "b".repeat(64),
    } as unknown as Env;

    const old = await signUnsubscribeToken(before, payload);
    expect(await verifyUnsubscribeToken(after, old)).toMatchObject(payload);

    const fresh = await signUnsubscribeToken(after, payload);
    expect(fresh).not.toBe(old);
    // Signed with EMAIL_TOKEN_KEY, not ENCRYPTION_KEY: it verifies where only that key matches.
    expect(await verifyUnsubscribeToken(emailKeyOnly, fresh)).toMatchObject(payload);
    expect(await verifyUnsubscribeToken(before, fresh)).toBeNull();
  });
});
