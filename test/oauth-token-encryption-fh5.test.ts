import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { decryptOAuthToken, setTokenUtil } from "better-auth/oauth2";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import * as authSchema from "~/db/auth-schema";
import { account, user } from "~/db/auth-schema";
import { authOptions } from "~/lib/auth/options";
import { encryptStoredOAuthTokens, readsAsEncrypted } from "~/lib/auth/oauth-token-encryption.server";

import { createInMemoryDb } from "./helpers/inmemory-db";

// Grok audit FH-5: Google OAuth tokens stored before encryptOAuthTokens was on
// are encrypted in place, in the form Better Auth itself decrypts on read.

const SECRET = "test-secret-0123456789abcdef0123456789abcdef";
const UPDATED = new Date("2026-10-01T00:00:00Z");

/** A typed instance's $context, as the AuthContext better-auth/oauth2 declares. */
const tokenCtx = (ctx: unknown) => ctx as Parameters<typeof setTokenUtil>[1];

async function setup() {
  const { db } = createInMemoryDb();
  const auth = betterAuth({
    ...authOptions,
    secret: SECRET,
    baseURL: "https://foxhoundapp.test",
    database: drizzleAdapter(db, { provider: "sqlite", schema: authSchema }),
  });
  const ctx = await auth.$context;
  await db.insert(user).values({ id: "u1", name: "Sample", email: "sample@example.com", emailVerified: true, updatedAt: UPDATED });
  return { db, ctx };
}

describe("encryptStoredOAuthTokens", () => {
  it("encrypts plain-text Google tokens so Better Auth reads back the originals, clears the id token, and leaves the rest alone", async () => {
    const { db, ctx } = await setup();
    const sealedAlready = await setTokenUtil("ya29.sealed-before", tokenCtx(ctx));
    await db.insert(account).values([
      { id: "g-plain", accountId: "g1", providerId: "google", userId: "u1", accessToken: "ya29.access", refreshToken: "1//refresh", idToken: "eyJ.id.token", updatedAt: UPDATED },
      { id: "g-sealed", accountId: "g2", providerId: "google", userId: "u1", accessToken: sealedAlready, updatedAt: UPDATED },
      { id: "cred", accountId: "u1", providerId: "credential", userId: "u1", password: "hash", updatedAt: UPDATED },
    ]);
    const before = await db.select().from(account);

    const first = await encryptStoredOAuthTokens(db, ctx);
    expect(first.rowsProcessed).toBe(1);

    const [plain] = await db.select().from(account).where(eq(account.id, "g-plain"));
    expect(plain.idToken).toBeNull();
    for (const [column, original] of [["accessToken", "ya29.access"], ["refreshToken", "1//refresh"]] as const) {
      const stored = plain[column] as string;
      expect(stored).not.toContain(original);
      expect(readsAsEncrypted(stored)).toBe(true);
      expect(await decryptOAuthToken(stored, tokenCtx(ctx))).toBe(original);
    }
    const untouched = (id: string) => [before.find((r) => r.id === id), id] as const;
    for (const [row, id] of [untouched("g-sealed"), untouched("cred")]) {
      const [now] = await db.select().from(account).where(eq(account.id, id));
      expect(now).toEqual(row);
    }

    const second = await encryptStoredOAuthTokens(db, ctx);
    expect(second.rowsProcessed).toBe(0);
  });

  it("Better Auth's own account writes never store the id token", async () => {
    const { db, ctx } = await setup();
    const created = await ctx.internalAdapter.createAccount({ accountId: "g3", providerId: "google", userId: "u1", accessToken: "a", idToken: "eyJ.created" });
    await ctx.internalAdapter.updateAccount(created.id, { idToken: "eyJ.updated" });
    const [row] = await db.select().from(account).where(eq(account.id, created.id));
    expect(row.idToken).toBeNull();
  });
});
