// Redirect URI rules for the OAuth provider (J79). Pure, so the page, the
// endpoints and the tests share one copy.

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1"]);

/**
 * Recova's port-agnostic loopback match (lib/oauth.ts, e3a404cd): a registered
 * `http://localhost/callback` matches `http://localhost:53682/callback`, because
 * a native client such as Claude Code picks a random port (RFC 8252 section
 * 7.3). Everything else must match exactly.
 */
function normalizeForMatch(uri: string): string {
  try {
    const u = new URL(uri);
    if (u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname)) {
      u.port = "";
      return u.toString();
    }
    return uri;
  } catch {
    return uri;
  }
}

export function isRegisteredRedirect(provided: string, registered: readonly string[]): boolean {
  if (registered.includes(provided)) return true;
  const normalized = normalizeForMatch(provided);
  return registered.some((r) => normalizeForMatch(r) === normalized);
}

/** The token exchange's redirect_uri must be the one the code was issued for,
 *  loopback ports aside (Recova's redirectUriMatchesCode). */
export function redirectUriMatchesCode(provided: string, stored: string): boolean {
  return provided === stored || normalizeForMatch(provided) === normalizeForMatch(stored);
}

/** Schemes a redirect may never use: each one runs or renders content in the
 *  browser instead of handing the code to a client. */
const REFUSED_SCHEMES = new Set(["javascript:", "data:", "vbscript:", "file:", "blob:", "about:"]);

/**
 * May a client register this redirect URI? Recova stored any non-empty string.
 * Foxhound keeps every shape a real agent uses (https, http on loopback for a
 * native client, and a private-use scheme such as cursor:// for a desktop app)
 * and refuses the ones that would hand a code to a page instead: plain http to
 * a real host, script and data schemes, and a fragment (RFC 6749 section
 * 3.1.2).
 */
export function isAcceptableRedirectUri(uri: string): boolean {
  if (uri.length > 2000) return false;
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash || uri.includes("#")) return false;
  if (REFUSED_SCHEMES.has(u.protocol)) return false;
  if (u.protocol === "https:") return u.hostname.length > 0;
  if (u.protocol === "http:") return LOOPBACK_HOSTS.has(u.hostname);
  // A private-use scheme (RFC 8252 section 7.1): a letter, then letters,
  // digits, plus, dot or hyphen.
  return /^[a-z][a-z0-9+.-]*:$/.test(u.protocol);
}
