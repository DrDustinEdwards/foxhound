import { readThemeCookie } from "capsomer/theme-server";
import { eq } from "drizzle-orm";

import { getDb, type Db } from "~/db";
import { accounts } from "~/db/schema";
import { resolveActiveMembership } from "./auth/account";
import { getSession } from "./auth/session";
import { resolveThemePreference, THEME_COOKIE, type Theme } from "./theme";

// Better Auth's default session cookie is `better-auth.session_token` (no cookiePrefix is
// configured in auth/options.ts).
const SESSION_COOKIE_MARKER = "session_token";

/**
 * The theme this request should render under, preferring the merchant's stored accounts.theme over
 * the device cookie. The session and account reads only happen for requests that could actually
 * have a stored preference. The matching write is setAccountTheme below, which must be called from
 * an action, never a loader.
 */
export async function resolveThemeForRequest(env: Env, request: Request): Promise<Theme> {
  const cookieTheme = readThemeCookie(request, THEME_COOKIE);

  const header = request.headers.get("Cookie") ?? "";
  if (!header.includes(SESSION_COOKIE_MARKER)) {
    return resolveThemePreference({ accountTheme: null, cookieTheme });
  }

  const session = await getSession(env, request);
  if (!session) return resolveThemePreference({ accountTheme: null, cookieTheme });

  const db = getDb(env);
  // THE ACTIVE ACCOUNT, not the earliest.
  const membership = await resolveActiveMembership(
    db,
    session.user.id,
    session.session.activeAccountId ?? null,
  );
  if (!membership) return resolveThemePreference({ accountTheme: null, cookieTheme });

  const row = await db
    .select({ theme: accounts.theme })
    .from(accounts)
    .where(eq(accounts.id, membership.accountId))
    .get();

  return resolveThemePreference({ accountTheme: row?.theme ?? null, cookieTheme });
}

/**
 * Persist a merchant's theme to their account so it follows them across devices and sessions.
 * ACTION ONLY. Loaders must not mutate, and that includes helpers they call: a nav-context write
 * once hid outside the routes tree for weeks (core.md standing rules). The only caller is the
 * action in routes/api/theme.ts.
 */
export async function setAccountTheme(db: Db, accountId: string, theme: Theme): Promise<void> {
  await db.update(accounts).set({ theme }).where(eq(accounts.id, accountId));
}
