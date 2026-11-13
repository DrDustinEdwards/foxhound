import { standardFiles } from "@drdustinedwards/site-helpers/files";

import { INDEXNOW_KEY } from "~/lib/seo/indexnow-key";
import { SITE_ORIGIN, SUPPORT_EMAIL } from "~/lib/seo/jsonld";

// The machine files, from Prelum's standardFiles, answered by the shared
// Worker before React Router (workers/app.ts `files`): robots.txt, ai.txt,
// site.webmanifest and the IndexNow key file. security.txt is site-runtime's
// gateway's, with the network's contact.
//
// robots.txt was ported from legacy app/robots.ts (Phase 6 Pass 2), rebuilt
// against Foxhound's OWN route structure (ROUTES.md), not legacy's. The
// disallow list covers every authenticated/sensitive Foxhound path (App, Auth,
// Public-utility, Webhooks, Admin sections of ROUTES.md); everything else
// (marketing, blog, docs, pricing, /audit) is crawlable.
export const DISALLOW_PATHS = [
  "/console",
  // The audit's NON-MARKETING surfaces only. `/audit` itself is the public
  // estimator and stays crawlable, so this cannot be a bare "/audit" prefix.
  // Legacy disallows `/audit/dashboard` and `/audit/results/` and leaves
  // `/audit/connect` and the bare `/audit/results` crawlable; the second of
  // those is a legacy near-miss, since `/audit/results/` with the slash does
  // not match `/audit/results` without one, and the page it leaves open is a
  // token-gated render of somebody's live financials that only ever redirects
  // for a crawler. Foxhound disallows the exact path. `/audit/connect` and
  // `/audit/callback` join it: one is a step inside a flow, the other is an
  // OAuth return, and neither is a destination.
  "/audit/dashboard",
  "/audit/connect",
  "/audit/callback",
  "/audit/results",
  // Every product page sits below its prefix since J09's URL reverts
  // (/recovery/dashboard, /disputes/dashboard, /intelligence/dashboard), so
  // the prefix carries its slash, as legacy writes '/disputes/' and
  // '/intelligence/'.
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
  // The OAuth consent page, a step inside an agent's connect flow and
  // never a destination. Recova's app/robots.ts disallows '/oauth/' too.
  "/oauth/",
  // The merchant MCP endpoint. An agent connects with a bearer key and a
  // crawler has no business there: it is POST-only, so a crawl can only ever
  // collect a 405. Every named group inherits this by the parity rule below.
  "/mcp",
];

// The bot set is the family's one policy, Prelum's default (Dustin, 2026-10-25):
// the search engines, the AI search and citation agents, and the training
// crawlers are allowed (the training crawlers so they reach Cloudflare's Pay Per
// Crawl price, where AI Crawl Control charges or blocks them), and Bytespider is
// denied. It names the same sixteen bots ruling 90 settled.
//
// Every named group repeats DISALLOW_PATHS: a crawler that matches a named group
// uses ONLY that group, so a bare `Allow: /` would have invited Googlebot, GPTBot
// and the rest into every path the wildcard excludes. `/e/c/:token` is the one
// that matters: it records the billable `email_engaged` signal. Prelum's
// `robotsDocument` writes the repetition.
//
// ROBOTS.TXT IS THE ADVISORY HALF: the enforcing half is the server-side guard
// at the click recorder, app/lib/engagement/agents.ts.
//
// ai.txt is the family's AI usage policy: answer engines may cite and link,
// training rights are reserved (the TDMRep header in app/lib/http/header-set.ts
// says the same) and licensed through support. Its disallow list is robots.txt's.
export const siteFiles = standardFiles({
  origin: SITE_ORIGIN,
  disallow: DISALLOW_PATHS,
  robots: { notes: [] },
  ai: { name: "Foxhound", contact: SUPPORT_EMAIL },
  manifest: { name: "Foxhound", themeColor: "#f0b429", backgroundColor: "#111210" },
  indexNowKey: INDEXNOW_KEY,
});
