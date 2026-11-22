// Redirect URI rules for the OAuth provider. Pure, so the page, the
// endpoints and the tests share one copy.

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1"]);

/** Everything else must match exactly. */
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

/**
 * The token exchange's redirect_uri must be the one the code was issued for, loopback ports aside.
 */
export function redirectUriMatchesCode(provided: string, stored: string): boolean {
  return provided === stored || normalizeForMatch(provided) === normalizeForMatch(stored);
}

/**
 * Schemes a redirect may never use. The person still has to approve first, but a consent page is no
 * place to launch a system tool.
 */
const REFUSED_SCHEMES = new Set([
  "javascript:",
  "data:",
  "vbscript:",
  "file:",
  "blob:",
  "about:",
  "filesystem:",
  "view-source:",
  "jar:",
  "search-ms:",
  "search:",
  "shell:",
  "mk:",
  "its:",
  "hcp:",
  "intent:",
  "ftp:",
  "ws:",
  "wss:",
  "ldap:",
  "smb:",
  "mailto:",
  "tel:",
  "sms:",
]);

/** Every Windows protocol handler shares this prefix (ms-msdt, ms-settings,
 *  ms-officecmd, ms-word and the rest); no agent client uses it. */
const REFUSED_SCHEME_PREFIX = "ms-";

/** May a client register this redirect URI? */
export function isAcceptableRedirectUri(uri: string): boolean {
  if (uri.length > 2000) return false;
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash || uri.includes("#")) return false;
  if (REFUSED_SCHEMES.has(u.protocol) || u.protocol.startsWith(REFUSED_SCHEME_PREFIX)) return false;
  if (u.protocol === "https:") return u.hostname.length > 0;
  if (u.protocol === "http:") return LOOPBACK_HOSTS.has(u.hostname);
  // A private-use scheme (RFC 8252 section 7.1): a letter, then letters, digits, plus, dot or
  // hyphen.
  return /^[a-z][a-z0-9+.-]*:$/.test(u.protocol);
}
