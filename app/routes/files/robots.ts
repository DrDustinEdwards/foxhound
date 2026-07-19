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
// search: each gets its own rule (not grouped), per the task spec. Bytespider
// and CCBot are explicitly denied (undifferentiated training scrapers, not
// AI products with a citation/answer surface).
const DISALLOW_PATHS = [
  "/dashboard",
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

const ALLOWED_BOTS = [
  "Googlebot",
  "Bingbot",
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "ClaudeBot",
  "Claude-SearchBot",
  "Claude-User",
  "Perplexitybot",
  "Perplexity-User",
  "Google-Extended",
];

const DENIED_BOTS = ["Bytespider", "CCBot"];

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
