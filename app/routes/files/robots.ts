import { cloudflareContext } from "~/lib/cloudflare-context";
import { siteUrl } from "~/lib/seo/jsonld";

import type { Route } from "./+types/robots";

// Ported from legacy app/robots.ts (Phase 6 Pass 2), rebuilt against
// Foxhound's OWN route structure (ROUTES.md), not legacy's. The disallow
// list covers every authenticated/sensitive Foxhound path (App, Auth,
// Public-utility, Webhooks, Admin sections of ROUTES.md); everything else
// (marketing, blog, docs, pricing, /audit) is crawlable.
//
// The per-bot allow rules are GEO signals for AI crawlers and LLM-powered
// search: each gets its own rule, not grouped.
//
// The bot set is legacy's allow-posture updated for 2026 (Dustin, ruling 90).
// It is NOT a ratification of what this file used to do: an earlier version
// denied CCBot and dropped four bots legacy allows, justified by a comment
// citing "the task spec", which is the calcification pattern (a doc cited to
// overrule legacy) and is struck.
//
// All thirteen bots legacy names are allowed, CCBot included: Common Crawl
// feeds the training sets the AI-citation strategy targets, so denying it
// contradicts the strategy published on this very site (llms.txt invites
// exactly these crawlers). The four legacy bots that had gone missing
// (anthropic-ai, Applebot, Applebot-Extended, DuckDuckBot) are restored.
// Three newer citation-surface agents are kept as a ratified addition
// (Claude-SearchBot, Claude-User, Perplexity-User).
//
// Bytespider is the ONE ratified deny: an undifferentiated training scraper
// with no citation or answer surface, so no upside to the strategy above.
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
  "/audit/runs/",
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
  "/billing",
  "/settings",
  "/help",
  "/welcome",
  "/login",
  "/signup",
  "/passkey",
  "/connect",
  "/invite",
  "/u/",
  "/p/",
  "/e/",
  "/webhooks/",
  "/admin",
  "/api/",
  "/auth/",
  // The OAuth consent page (J79), a step inside an agent's connect flow and
  // never a destination. Recova's app/robots.ts disallows '/oauth/' too.
  "/oauth/",
  // The merchant MCP endpoint (370). An agent connects with a bearer key and a
  // crawler has no business there: it is POST-only, so a crawl can only ever
  // collect a 405. Every named group inherits this by the parity rule below.
  "/mcp",
];

// Legacy's thirteen, in legacy's order, then the three ratified additions.
export const ALLOWED_BOTS = [
  "GPTBot",
  "ChatGPT-User",
  "OAI-SearchBot",
  "ClaudeBot",
  "anthropic-ai",
  "PerplexityBot",
  "Applebot",
  "Applebot-Extended",
  "Google-Extended",
  "Googlebot",
  "Bingbot",
  "DuckDuckBot",
  "CCBot",
  // Ratified additions (Dustin, ruling 90): citation-surface agents that did
  // not exist when legacy's list was written.
  "Claude-SearchBot",
  "Claude-User",
  "Perplexity-User",
];

export const DENIED_BOTS = ["Bytespider"];

/**
 * One allow-group: `Allow: /` plus the SAME disallow set the wildcard carries.
 *
 * THE DISALLOWS ARE REPEATED IN EVERY NAMED GROUP, AND THAT REPETITION IS THE
 * WHOLE FIX (368 ruling 1). Google's robots.txt documentation is explicit:
 * "User agent specific groups and global groups (`*`) are not combined." A
 * crawler that matches a named group uses ONLY that group. So the sixteen groups
 * below, which carried a bare `Allow: /`, were not narrowing the wildcard rules,
 * they were REPLACING them: Googlebot, Bingbot, GPTBot, ClaudeBot and twelve
 * others were invited into every path the wildcard excludes.
 *
 * The authenticated paths were never a data leak, because they redirect to
 * login. `/e/` was the one that mattered: `/e/c/:token` writes
 * `recovery_steps.clicked_at`, which `findAttributionSignals` reads as the
 * `email_engaged` signal, which is a BILLABLE attribution kind. A crawler
 * following a pasted dunning link could record a click no human made, one step
 * from an invoice. Reclassified by 368 from crawl hygiene to money integrity.
 *
 * THE NAMED GROUPS STILL EXIST FOR THE REASON THEY ALWAYS DID: to say YES
 * explicitly to the crawlers the AI-citation strategy depends on, which a bare
 * wildcard cannot do for an agent that looks for its own name. What changes is
 * that saying yes to the public content no longer says yes to everything else.
 *
 * ROBOTS.TXT IS THE ADVISORY HALF AND IS NOT SUFFICIENT ALONE (368 ruling 1): a
 * user-triggered fetcher does not uniformly honour it. The enforcing half is the
 * server-side guard at the click recorder, app/lib/engagement/agents.ts.
 */
function allowGroup(bot: string): string[] {
  return [
    `User-agent: ${bot}`,
    "Allow: /",
    ...DISALLOW_PATHS.map((path) => `Disallow: ${path}`),
    "",
  ];
}

export function buildRobotsTxt(url: string): string {
  const lines: string[] = [];

  lines.push(...allowGroup("*"));

  for (const bot of ALLOWED_BOTS) lines.push(...allowGroup(bot));

  for (const bot of DENIED_BOTS) {
    lines.push(`User-agent: ${bot}`);
    lines.push("Disallow: /");
    lines.push("");
  }

  lines.push(`Sitemap: ${url}/sitemap.xml`);

  return lines.join("\n") + "\n";
}

export function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  return new Response(buildRobotsTxt(siteUrl(env)), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=86400",
    },
  });
}
