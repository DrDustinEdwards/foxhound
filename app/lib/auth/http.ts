// Forward the Set-Cookie header(s) from a Better Auth `asResponse` result onto
// an outgoing Headers object, so a server action can issue its own redirect while
// preserving the session cookie Better Auth minted.
export function forwardSetCookie(from: Response, headers = new Headers()): Headers {
  for (const cookie of from.headers.getSetCookie()) {
    headers.append("Set-Cookie", cookie);
  }
  return headers;
}
