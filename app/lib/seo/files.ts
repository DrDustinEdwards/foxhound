import { standardFiles } from "@drdustinedwards/site-helpers/files";

import { INDEXNOW_KEY } from "~/lib/seo/indexnow-key";
import { SITE_ORIGIN, SUPPORT_EMAIL } from "~/lib/seo/jsonld";

// The disallow list covers every authenticated/sensitive Foxhound path (App, Auth, Public-utility,
// Webhooks, Admin sections of ROUTES.md); everything else (marketing, blog, docs, pricing, /audit)
// is crawlable.
export const DISALLOW_PATHS = [
  "/console",
  // The audit's NON-MARKETING surfaces only. Foxhound disallows the exact path.
  "/audit/dashboard",
  "/audit/connect",
  "/audit/callback",
  "/audit/results",
  "/recovery/",
  "/disputes/",
  "/intelligence/",
  // The four demo entries (/demos/recovery and the rest) set the demo cookie and redirect into the app; the /demos
  // page that lists them, with no slash, stays open.
  "/demos/",
  "/billing",
  "/settings",
  "/help",
  "/welcome",
  "/login",
  "/signup",
  "/passkey",
  "/sign-in/",
  "/email/confirm",
  "/connect",
  "/invite",
  "/u/",
  "/p/",
  "/e/",
  "/webhooks/",
  "/admin",
  "/api/",
  "/auth/",
  // The OAuth consent page, a step inside an agent's connect flow and never a destination.
  "/oauth/",
  // The merchant MCP endpoint. An agent connects with a bearer key and a crawler has no business
  // there: it is POST-only, so a crawl can only ever collect a 405.
  "/mcp",
];

// The bot set is the family's one policy, Prelum's default (Dustin): the search engines, the AI
// search and citation agents, and the training crawlers are allowed (the training crawlers so they
// reach Cloudflare's Pay Per Crawl price, where AI Crawl Control charges or blocks them), and
// Bytespider is denied. Every named group repeats DISALLOW_PATHS: a crawler that matches a named
// group uses ONLY that group, so a bare `Allow: /` would have invited Googlebot, GPTBot and the
// rest into every path the wildcard excludes.
export const siteFiles = standardFiles({
  origin: SITE_ORIGIN,
  disallow: DISALLOW_PATHS,
  robots: { notes: [] },
  ai: { name: "Foxhound", contact: SUPPORT_EMAIL },
  manifest: { name: "Foxhound", themeColor: "#f0b429", backgroundColor: "#111210" },
  indexNowKey: INDEXNOW_KEY,
});
