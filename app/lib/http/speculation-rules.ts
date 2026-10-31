import { SPECULATION_RULES_HEADER, type SpeculationOptions } from "@dustinedwards/site-runtime/prefetch";

// LINK PREFETCH WITHOUT A SCRIPT (site-runtime ./prefetch). The public pages no longer hydrate (root.tsx),
// so React Router's hover prefetch is gone from them; Chrome and Edge read these speculation rules instead,
// from /speculation-rules.json, which every HTML response names in its Speculation-Rules header
// (workers/app.ts). site-runtime already skips /admin, /api, /auth, /logout, files and links with a query.
// These are Foxhound's own: the signed-in app, everything that acts on a GET (the demo entries set the demo
// cookie, the token routes unsubscribe, finish a card update or record an engagement, the OAuth and Stripe
// returns exchange a code, /connect/additional mints a state cookie), and the sign-in, consent and
// audit flows. A prefix also covers everything under it; "/demos/" and "/audit/" leave /demos and /audit.
export const SPECULATION_OPTIONS: SpeculationOptions = {
  exclude: [
    // The merchant app (app-shell) and its settings.
    "/console",
    "/recovery",
    "/disputes",
    "/intelligence",
    "/billing",
    "/settings",
    "/help",
    "/welcome",
    // GETs that change state, and the flows that hold a session, a code or a token.
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

/** The response with the Speculation-Rules header when it is an HTML page; anything else as it was. */
export function withSpeculationRules(response: Response): Response {
  if (!response.headers.get("Content-Type")?.startsWith("text/html")) return response;
  // A copy: a response from the cache or a subrequest has immutable headers.
  const page = new Response(response.body, response);
  page.headers.set(SPECULATION_RULES_HEADER.name, SPECULATION_RULES_HEADER.value);
  return page;
}
