// The browser half of the family sign-in (site-runtime ./sign-in-client): the
// passkey and email-link plugins. Only the passkey needs it, because WebAuthn
// runs in the browser; every other sign-in step is a form posted to an action.
// baseURL defaults to the current origin.
import { signInClientPlugins } from "@dustinedwards/site-runtime/sign-in-client";
import { createAuthClient } from "better-auth/react";

import { REAUTH_PARAM } from "./next-path";

export const authClient = createAuthClient({ plugins: signInClientPlugins() });

/**
 * Adding a passkey and unlinking Google or Apple need a sign-in from the last
 * 10 minutes (site-runtime ./sign-in, FRESH_SECONDS). On Better Auth's
 * SESSION_NOT_FRESH the person logs in again and comes back to this page
 * (safeNextPath checks it there). True when it was that error and the page is
 * on its way.
 */
export function signInAgainIfStale(error: unknown): boolean {
  if ((error as { code?: string } | null)?.code !== "SESSION_NOT_FRESH") return false;
  signInAgain();
  return true;
}

/** Log in again and come back to this page, for a fresh sign-in. */
export function signInAgain(): void {
  const next = encodeURIComponent(location.pathname + location.search);
  window.location.assign(`/login?${REAUTH_PARAM}&next=${next}`);
}
