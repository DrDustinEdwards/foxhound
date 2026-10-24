// The browser half of the family sign-in (site-runtime ./sign-in-client): the
// passkey and email-link plugins. Only the passkey needs it, because WebAuthn
// runs in the browser; every other sign-in step is a form posted to an action.
// baseURL defaults to the current origin.
import { signInClientPlugins } from "@dustinedwards/site-runtime/sign-in-client";
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({ plugins: signInClientPlugins() });
