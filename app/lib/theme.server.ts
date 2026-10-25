import { readThemeCookie } from "capsomer/theme-server";
import { eq } from "drizzle-orm";

import { getDb, type Db } from "~/db";
import { accounts } from "~/db/schema";
import { resolveActiveMembership } from "./auth/account";
import { getSession } from "./auth/session";
import { resolveThemePreference, THEME_COOKIE, type Theme } from "./theme";

// Better Auth's default session cookie is `better-auth.session_token` (no
// cookiePrefix is configured in auth/options.ts). Matching the suffix is enough
// to answer "could this request possibly be signed in", which is all the gate
// below needs.
const SESSION_COOKIE_MARKER = "session_token";

/**
 * The theme this request should render under, preferring the merchant's stored
 * accounts.theme over the device cookie (ruling 59; legacy reader spec is
 * lib/theme-server.ts:18-19).
 *
 * ANONYMOUS REQUESTS STAY ZERO-DB, which the marketing loader depends on: with
 * no Better Auth session cookie present this cannot be a signed-in request, so
 * it returns the cookie value without touching D1. The session and account
 * reads only happen for requests that could actually have a stored preference.
 *
 * This is a READ. The matching write is setAccountTheme below, which must be
 * called from an action, never a loader.
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
  // THE ACTIVE ACCOUNT, not the earliest. This read used the null-marker shim
  // until session 61's phase (c) re-audit, so a merchant who had switched saw
  // the theme of the account they switched away from.
  //
  // LEGACY ALREADY DECIDED THIS, which is why it needed no ruling: its reader
  // (lib/theme-server.ts, blob `7fd9693e`) resolves through `resolveAccount`,
  // the same cookie-aware active-account resolver every other legacy surface
  // uses, and so does its writer (app/api/account/theme/route.ts, blob
  // `968ba672`). Foxhound's split was an accident of phase (b) leaving the pair
  // on the shim, not a Foxhound decision about whether theme follows a switch.
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
 * Persist a merchant's theme to their account so it follows them across
 * devices and sessions (ruling 59).
 *
 * ACTION ONLY. Loaders must not mutate, and that includes helpers they call:
 * a nav-context write once hid outside the routes tree for weeks (core.md
 * standing rules). The only caller is the action in routes/api/theme.ts.
 */
export async function setAccountTheme(db: Db, accountId: string, theme: Theme): Promise<void> {
  await db.update(accounts).set({ theme }).where(eq(accounts.id, accountId));
}
