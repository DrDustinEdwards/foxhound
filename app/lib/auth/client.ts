// The browser half of the family sign-in (site-runtime ./sign-in-client): the
// passkey and email-link plugins. Only the passkey needs it, because WebAuthn
// runs in the browser; every other sign-in step is a form posted to an action.
// baseURL defaults to the current origin.
import { signInClientPlugins } from "@dustinedwards/site-runtime/sign-in-client";
import { createAuthClient } from "better-auth/react";

import { REAUTH_PARAM } from "./next-path";

export const betterAuthClient = createAuthClient({ plugins: signInClientPlugins() });

/** The sign-in address for a fresh sign-in that comes back to `next` (site-runtime's signInAgainIfStale takes it). */
export const reauthHref = (next: string) =>
  `/login?${REAUTH_PARAM}&next=${encodeURIComponent(next)}`;

/** Log in again and come back to this page, for a fresh sign-in. */
export function signInAgain(): void {
  window.location.assign(reauthHref(location.pathname + location.search));
}
