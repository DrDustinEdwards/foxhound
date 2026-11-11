// The browser half of the family sign-in (site-runtime ./sign-in-client): the
// passkey and email-link plugins. Only the passkey, Google and Apple joins and
// the other-devices sign-out need it, because WebAuthn and the providers run in
// the browser; every other sign-in and account step is a form posted to an
// action. baseURL defaults to the current origin.
import { signInClientPlugins } from "@dustinedwards/site-runtime/sign-in-client";
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({ plugins: signInClientPlugins() });
