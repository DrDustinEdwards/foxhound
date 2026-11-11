// Where to land after signing in, for the OAuth authorize page's round trip
// through /login. The check itself is site-runtime's safeNextPath
// (./sign-in-form, which began as this file's Recova validateRedirect); call it
// with { fallback: DEFAULT_NEXT_PATH }.

/** Where a sign-in lands when next= is absent or refused, as in Recova. */
export const DEFAULT_NEXT_PATH = "/console";

/** /login's flag for a signed-in person who must sign in again (signInAgainIfStale). */
export const REAUTH_PARAM = "reauth";
