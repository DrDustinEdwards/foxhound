// Foxhound's sign-in paths, with no imports so a page's browser code can read
// them. Which `next` is allowed is site-runtime's safeNextPath (nextPath in
// landing.server.ts); only the fallback is Foxhound's.

/** Where a sign-in lands when next= is absent or refused, as in Recova. */
export const DEFAULT_NEXT_PATH = "/console";

/** /login's flag for a signed-in person who must sign in again, for a change
 *  that needs a sign-in from the last 10 minutes (site-runtime FRESH_SECONDS). */
export const REAUTH_PARAM = "reauth";

/** The sign-in page with the re-auth flag and `next` back to `returnTo`. */
export function signInAgainHref(returnTo: string): string {
  return `/login?${REAUTH_PARAM}&next=${encodeURIComponent(returnTo)}`;
}
