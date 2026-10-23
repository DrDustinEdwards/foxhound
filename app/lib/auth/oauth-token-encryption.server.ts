import { setTokenUtil } from "better-auth/oauth2";
import { and, eq, isNotNull, or } from "drizzle-orm";

import type { Db } from "~/db";
import { account } from "~/db/auth-schema";

// Encrypts the Google OAuth tokens that were stored before Better Auth's
// encryptOAuthTokens was turned on (Grok audit FH-5). New and refreshed tokens
// are encrypted by Better Auth itself (options.ts). Rows written before that
// still hold plain text, and Better Auth reads a value it does not recognise as
// ciphertext as plain text, so they would stay readable in D1 forever. Stored
// id tokens are cleared, as options.ts now stops writing them.
//
// Each value is encrypted with Better Auth's own setTokenUtil and the live auth
// context, so the stored form is exactly what Better Auth writes and decrypts
// (the BETTER_AUTH_SECRET, or the versioned BETTER_AUTH_SECRETS if one is set).

type AuthContext = Parameters<typeof setTokenUtil>[1];
/** The two fields setTokenUtil reads; any Better Auth instance's $context has them. */
type TokenContext = Pick<AuthContext, "options" | "secretConfig">;

const TOKEN_COLUMNS = ["accessToken", "refreshToken"] as const;

/** Better Auth's test for "this value is ciphertext" (isLikelyEncrypted in
 *  better-auth's oauth2/utils, which is not exported). It must match theirs: a
 *  value that passes is decrypted on read, a value that fails is returned as
 *  stored. */
export function readsAsEncrypted(token: string): boolean {
  if (token.startsWith("$ba$")) return true;
  return token.length % 2 === 0 && /^[0-9a-f]+$/i.test(token);
}

export interface OAuthTokenSweepResult {
  rowsProcessed: number;
  message: string;
}

/**
 * Encrypt every stored access or refresh token Better Auth would still read as
 * plain text, and clear every stored id token.
 * Idempotent: a run with nothing left to encrypt writes nothing. Each UPDATE is
 * guarded on the value it read, so a token Better Auth rewrote in between (it
 * writes ciphertext now) is never overwritten with an older one.
 */
export async function encryptStoredOAuthTokens(db: Db, ctx: TokenContext): Promise<OAuthTokenSweepResult> {
  if (!ctx.options.account?.encryptOAuthTokens) {
    // setTokenUtil returns the token unchanged in this case, so the sweep
    // would rewrite plain text as plain text and report it done.
    throw new Error("account.encryptOAuthTokens is off; refusing to report tokens as encrypted");
  }
  const rows = await db
    .select({
      id: account.id,
      accessToken: account.accessToken,
      refreshToken: account.refreshToken,
      idToken: account.idToken,
    })
    .from(account)
    .where(or(isNotNull(account.accessToken), isNotNull(account.refreshToken), isNotNull(account.idToken)));

  const updates = [];
  const rowIds = new Set<string>();
  for (const row of rows) {
    for (const column of TOKEN_COLUMNS) {
      const plain = row[column];
      if (plain === null || readsAsEncrypted(plain)) continue;
      const sealed = await setTokenUtil(plain, ctx as AuthContext);
      updates.push(
        db
          .update(account)
          .set({ [column]: sealed })
          .where(and(eq(account.id, row.id), eq(account[column], plain))),
      );
      rowIds.add(row.id);
    }
  }
  for (const row of rows) {
    if (row.idToken === null) continue;
    updates.push(
      db.update(account).set({ idToken: null }).where(and(eq(account.id, row.id), eq(account.idToken, row.idToken))),
    );
    rowIds.add(row.id);
  }
  if (updates.length > 0) {
    await db.batch(updates as [(typeof updates)[number], ...typeof updates]);
  }
  return {
    rowsProcessed: rowIds.size,
    message: `${updates.length} plain-text OAuth token(s) encrypted or cleared across ${rowIds.size} account row(s)`,
  };
}
