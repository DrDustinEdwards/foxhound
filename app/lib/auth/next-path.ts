// Where to land after signing in: Recova's validateRedirect
// (app/(auth)/login/page.tsx, blob ec09cd24), one of ruling 8's inherited
// artifacts, for the OAuth authorize page's round trip through /login (J79).

/** Where a sign-in lands when next= is absent or refused, as in Recova. */
export const DEFAULT_NEXT_PATH = "/console";

/**
 * URLSearchParams.get already decodes once. A second decode is Recova's
 * defence against a next= that a link builder encoded twice, and a stray "%"
 * falls back to the input.
 *
 * RECOVA DECODED EVERY VALUE AGAIN, and its comment said that was a no-op on a
 * properly encoded value. It is not: an authorize URL's own query is encoded
 * (redirect_uri=https%3A%2F%2F...), so the second decode rewrote it, and a
 * state carrying an encoded "&" would have been split in two. Here the second
 * decode runs only on a value that is not already a path, which is exactly the
 * doubly encoded case ("%2Foauth%2Fauthorize...").
 */
function tryDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * An internal path only. EVERY CHECK IS ANCHORED AT POSITION 0 with
 * startsWith, never includes() or an anywhere-in-string pattern: the query may
 * legitimately carry "https://" or "//", because RFC 8707's resource= is an
 * absolute URL, and rejecting on a substring would break every OAuth flow
 * that names its resource. Absolute, protocol-relative ("//host") and
 * backslash ("/\host", which some browsers read as "//host") targets are
 * refused.
 */
export function safeNextPath(raw: string | null | undefined): string {
  if (!raw) return DEFAULT_NEXT_PATH;
  const url = raw.startsWith("/") ? raw : tryDecode(raw);
  // A browser strips tabs and newlines while parsing a URL, so "/\t/host"
  // becomes "//host". Recova's validator let that through; no real path
  // carries a control character or a space, so any is refused.
  for (const ch of url) {
    const code = ch.charCodeAt(0);
    if (code <= 0x20 || code === 0x7f) return DEFAULT_NEXT_PATH;
  }
  if (url.startsWith("/") && !url.startsWith("//") && !url.startsWith("/\\")) return url;
  return DEFAULT_NEXT_PATH;
}
