// Where to land after signing in, for the OAuth authorize page's round trip
// through /login.

export const DEFAULT_NEXT_PATH = "/console";

/**
 * /login's flag for a signed-in person who must sign in again
 * (signInAgainIfStale).
 */
export const REAUTH_PARAM = "reauth";
