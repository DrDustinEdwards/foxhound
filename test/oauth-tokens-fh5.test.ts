import { readFileSync } from "node:fs";

import { signInOptions } from "@dustinedwards/site-runtime/sign-in";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { describe, expect, it } from "vitest";

import * as authSchema from "~/db/auth-schema";
import { withSignIn } from "~/lib/auth/options";

import { createInMemoryDb } from "./helpers/inmemory-db";

// FH-5: Foxhound stores no Google tokens. A Google sign-in's account writes
// (createOAuthUser on sign-up, updateAccount on each later sign-in) keep none,
// through site-runtime's hooks merged as auth.server.ts merges them (withSignIn),
// and the clear_oauth_tokens migration clears the rows stored before. Fake
// tokens and a fake secret.
const TOKENS = {
  accessToken: "ya29.a0-fake-access-token",
  refreshToken: "1//0fake-refresh-token",
  idToken: "eyJhbGciOiJub25lIn0.eyJzdWIiOiJzYW1wbGUifQ.",
  accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
};
const NONE = { access_token: null, refresh_token: null, id_token: null, access_token_expires_at: null };

describe("Google tokens", () => {
  it("are never stored, and the migration clears old ones", async () => {
    const { sqlite, db } = createInMemoryDb();
    const env = { BETTER_AUTH_URL: "https://foxhoundapp.test" };
    const signIn = await signInOptions(env, { siteName: "Foxhound", social: true, sendMagicLink: async () => {} });
    const { internalAdapter } = await betterAuth({
      ...withSignIn(signIn),
      secret: "test-secret-0123456789abcdef0123456789abcdef",
      baseURL: "https://foxhoundapp.test",
      database: drizzleAdapter(db, { provider: "sqlite", schema: authSchema }),
    }).$context;
    const tokensOf = (id: string) =>
      sqlite
        .prepare("SELECT access_token, refresh_token, id_token, access_token_expires_at FROM account WHERE id = ?")
        .get(id);

    const { account } = await internalAdapter.createOAuthUser(
      { name: "Sample", email: "oauth@example.com", emailVerified: true },
      { providerId: "google", accountId: "g-1", ...TOKENS },
    );
    expect(tokensOf(account.id)).toEqual(NONE);
    await internalAdapter.updateAccount(account.id, TOKENS);
    expect(tokensOf(account.id)).toEqual(NONE);

    const now = Date.now();
    sqlite
      .prepare(
        "INSERT INTO account (id, account_id, provider_id, user_id, access_token, refresh_token, id_token, access_token_expires_at, created_at, updated_at) VALUES ('a-old', 'g-2', 'google', ?, 'a', 'r', 'i', ?, ?, ?)",
      )
      .run(account.userId, now, now, now);
    sqlite.exec(readFileSync(new URL("../drizzle/migrations/0034_clear_oauth_tokens.sql", import.meta.url), "utf8"));
    expect(tokensOf("a-old")).toEqual(NONE);
  });
});
