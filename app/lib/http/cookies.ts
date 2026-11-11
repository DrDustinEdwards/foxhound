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

/** A cookie's name without its `__Host-` or `__Secure-` prefix: site-runtime's
 *  readCookie takes the bare name and reads the prefixed one. */
export function bare(name: string): string {
  return name.replace(/^__(?:Host|Secure)-/, "");
}
