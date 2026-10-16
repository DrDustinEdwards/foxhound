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

/**
 * Schemes a redirect may never use. Each one runs or renders content in the
 * browser, or hands the URL to an operating-system handler (some of which have
 * run code from a crafted URL, ms-msdt's Follina among them), instead of
 * handing the code to a client. The person still has to approve first, but a
 * consent page is no place to launch a system tool.
 */
const REFUSED_SCHEMES = new Set([
  "javascript:", "data:", "vbscript:", "file:", "blob:", "about:", "filesystem:", "view-source:", "jar:",
  "search-ms:", "search:", "shell:", "mk:", "its:", "hcp:", "intent:",
  "ftp:", "ws:", "wss:", "ldap:", "smb:", "mailto:", "tel:", "sms:",
]);

/** Every Windows protocol handler shares this prefix (ms-msdt, ms-settings,
 *  ms-officecmd, ms-word and the rest); no agent client uses it. */
const REFUSED_SCHEME_PREFIX = "ms-";

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
  if (REFUSED_SCHEMES.has(u.protocol) || u.protocol.startsWith(REFUSED_SCHEME_PREFIX)) return false;
  if (u.protocol === "https:") return u.hostname.length > 0;
  if (u.protocol === "http:") return LOOPBACK_HOSTS.has(u.hostname);
  // A private-use scheme (RFC 8252 section 7.1): a letter, then letters,
  // digits, plus, dot or hyphen. RFC 8252 asks for a reverse-domain name
  // ("com.example.app"), but it is a SHOULD and real desktop clients register
  // bare ones (cursor://, vscode://), so a dotless scheme is still accepted;
  // the refused list above is what keeps system handlers out.
  return /^[a-z][a-z0-9+.-]*:$/.test(u.protocol);
}
