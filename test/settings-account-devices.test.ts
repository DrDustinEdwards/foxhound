import { signInOptions } from "@dustinedwards/site-runtime/sign-in";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { describe, expect, it, vi } from "vitest";

import { accounts } from "~/db";
import * as authSchema from "~/db/auth-schema";
import { authContext } from "~/lib/auth/context";
import { withSignIn } from "~/lib/auth/options";
import { cloudflareContext } from "~/lib/cloudflare-context";

import { createInMemoryDb } from "./helpers/inmemory-db";

// The Signed-in devices list on /settings/account: Better Auth's /list-sessions,
// through the family sign-in's options, against the real schema. It wants a
// sign-in from the last 10 minutes; past that the page still loads and asks for
// one, which is every merchant who opens it more than 10 minutes after signing
// in. Fake user, fake secret.

const ORIGIN = "https://foxhoundapp.test";
const SECRET = "test-secret-0123456789abcdef0123456789abcdef";
const env = { BETTER_AUTH_URL: ORIGIN } as unknown as Env;
const { sqlite, db } = createInMemoryDb();
const signIn = await signInOptions(env, { siteName: "Foxhound", social: true, sendMagicLink: async () => {} });
const auth = betterAuth({
  ...withSignIn(signIn),
  secret: SECRET,
  baseURL: ORIGIN,
  database: drizzleAdapter(db, { provider: "sqlite", schema: authSchema }),
});

vi.mock("~/db", async (importOriginal) => ({ ...(await importOriginal<typeof import("~/db")>()), getDb: () => db }));
vi.mock("~/lib/auth/auth.server", () => ({ getAuth: async () => auth }));

const { loader } = await import("~/routes/app/settings/account");

/** The session cookie as Better Auth signs it: the token, a dot, its HMAC. */
async function cookieFor(token: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(token));
  return `__Secure-better-auth.session_token=${encodeURIComponent(`${token}.${Buffer.from(mac).toString("base64")}`)}`;
}

async function load(token: string) {
  const context = {
    get(key: unknown) {
      if (key === cloudflareContext) return { env, ctx: {} as ExecutionContext, nonce: "n" };
      if (key === authContext) {
        return {
          userId,
          email: "owner@example.com",
          membership: { memberId: "m1", accountId: "acct_1", accountName: "Sample", role: "owner" },
          memberships: [],
          isDemo: false,
        };
      }
      throw new Error("unexpected context key");
    },
  };
  const request = new Request(`${ORIGIN}/settings/account`, { headers: { cookie: await cookieFor(token) } });
  return loader({ request, context, params: {} } as never);
}

const { internalAdapter } = await auth.$context;
const { id: userId } = await internalAdapter.createUser(
  { name: "Sample", email: "owner@example.com", emailVerified: true },
  { method: "magic-link" },
);
await db.insert(accounts).values({ id: "acct_1", name: "Sample", createdAt: new Date() });

describe("Signed-in devices", () => {
  it("lists this person's sessions, this one first, and asks for a fresh sign-in once it is 10 minutes old", async () => {
    const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
    await internalAdapter.createSession(userId, false, { userAgent: iphone });
    const current = await internalAdapter.createSession(userId);

    const fresh = await load(current.token);
    expect(fresh.signIn.devices).toMatchObject([
      { token: current.token, current: true },
      { device: "Safari on iPhone", current: false },
    ]);

    sqlite.prepare("UPDATE session SET created_at = ? WHERE token = ?").run(Date.now() - 11 * 60_000, current.token);
    expect((await load(current.token)).signIn.devices).toBe("stale");
  });
});
