import type { SpeculationOptions } from "@dustinedwards/site-runtime/prefetch";

// Link prefetch without a script (site-runtime ./prefetch): public pages no longer hydrate, so Chrome and Edge
// read these rules from /speculation-rules.json. site-runtime already skips /admin, /api, /auth, /logout, files
// and links with a query. These are Foxhound's own: the signed-in app, every GET that acts (demo entries set
// the cookie, token routes unsubscribe or record, OAuth and Stripe returns exchange a code, /connect/additional
// mints a state cookie), and the sign-in, consent and audit flows. A prefix covers everything under it.
export const SPECULATION_OPTIONS: SpeculationOptions = {
  exclude: [
    "/console",
    "/recovery",
    "/disputes",
    "/intelligence",
    "/billing",
    "/settings",
    "/help",
    "/welcome",
    "/demos/",
    "/demo",
    "/connect",
    "/audit/",
    "/oauth",
    "/invite",
    "/u",
    "/p",
    "/e",
    "/login",
    "/signup",
    "/passkey",
    "/sign-in",
    "/marketing",
    "/mcp",
  ],
};
