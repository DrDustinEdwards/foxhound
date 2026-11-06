import { hostCookie } from "@dustinedwards/site-runtime/headers";

const HOST_PREFIX = "__Host-";

/**
 * A Set-Cookie for one of Foxhound's own cookies, through site-runtime's hostCookie (__Host-, Path=/, Secure, HttpOnly,
 * SameSite=Lax). `name` is the full name with its prefix, the one constant its reader uses too. `maxAge: 0` ends it.
 */
export function setHostCookie(name: string, value: string, maxAge: number): string {
  if (!name.startsWith(HOST_PREFIX)) throw new Error(`${name} is not a __Host- cookie name`);
  return hostCookie(name.slice(HOST_PREFIX.length), value, { maxAge });
}

/** The value of the cookie `name` on the request, trimmed, or null when it is
 *  not sent. */
export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie") ?? "";
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}
