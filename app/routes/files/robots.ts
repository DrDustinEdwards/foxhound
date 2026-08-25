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
const DISALLOW_PATHS = [
  "/dashboard",
  // The audit's AUTHENTICATED surfaces only. `/audit` itself is the public
  // estimator and stays crawlable, so this cannot be a bare "/audit" prefix.
  "/audit/history",
  "/audit/runs/",
  "/recovery",
  "/disputes",
  "/intelligence",
  "/billing",
  "/settings",
  "/help",
  "/welcome",
  "/login",
  "/signup",
  "/forgot-password",
  "/reset-password",
  "/connect",
  "/invite",
  "/u/",
  "/p/",
  "/e/",
  "/webhooks/",
  "/admin",
  "/api/",
  "/auth/",
];

// Legacy's thirteen, in legacy's order, then the three ratified additions.
const ALLOWED_BOTS = [
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

const DENIED_BOTS = ["Bytespider"];

function buildRobotsTxt(url: string): string {
  const lines: string[] = [];

  lines.push("User-agent: *");
  lines.push("Allow: /");
  for (const path of DISALLOW_PATHS) lines.push(`Disallow: ${path}`);
  lines.push("");

  for (const bot of ALLOWED_BOTS) {
    lines.push(`User-agent: ${bot}`);
    lines.push("Allow: /");
    lines.push("");
  }

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
