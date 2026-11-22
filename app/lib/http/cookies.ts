import { hostCookie } from "@dustinedwards/site-runtime/headers";

const HOST_PREFIX = "__Host-";

/** A Set-Cookie for one of Foxhound's own cookies via site-runtime's hostCookie (__Host-, Path=/, Secure, HttpOnly,
 *  SameSite=Lax). `name` is the full prefixed name; `maxAge: 0` ends it. */
export function setHostCookie(name: string, value: string, maxAge: number): string {
  if (!name.startsWith(HOST_PREFIX)) throw new Error(`${name} is not a __Host- cookie name`);
  return hostCookie(name.slice(HOST_PREFIX.length), value, { maxAge });
}

/** A cookie's name without its `__Host-` or `__Secure-` prefix, which site-runtime's readCookie takes. */
export function bare(name: string): string {
  return name.replace(/^__(?:Host|Secure)-/, "");
}
