import { llmsDocument, llmsLink } from "@drdustinedwards/site-helpers/llms";

import { getDb } from "~/db";
import { postsByPrimaryTopic, topicsInLlmsOrder, type PublishedSet } from "~/lib/blog/published-set";
import { loadPublishedSet } from "~/lib/blog/published-set.server";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { RECOVERY_SEQUENCE_DAYS } from "~/lib/marketing/decline-categories";
import { siteUrl, SUPPORT_EMAIL } from "~/lib/seo/jsonld";

import { forAgentsSection } from "./llms";
import type { Route } from "./+types/llms-full";

// /llms-full.txt (row F4, J61). Recova's app/llms-full.txt/route.ts is the
// spec for the shape, in its order: Company, Products, Pricing summary,
// Technical architecture, the MCP section, the complete article index grouped
// by cluster, Crawling permissions. Prelum's llmsDocument writes the title and
// summary block and llmsLink each article line (Q2); the prose sections between
// them are written here, because llmsDocument takes link lists only.
//
// Same constraints as llms.ts: Foxhound's real lineup and facts, never Recova's
// copy; no specific pricing numbers (PRICING.md names this file); all URLs from
// siteUrl(env); no hand-typed "Updated:" date (RULES.md 2.6). Recova's company
// lines ("Founded", "Headquarters") and its AI-model line are not carried: each
// is a claim about Foxhound that no source in this repo states, and a claim
// waits for a ruling (RULES.md 2.2).
//
// THE ARTICLE INDEX lists every published post once, from the one published
// set the sitemaps and feeds read, under its first topic in Recova's topic
// order, as Recova's index files each post once. The count is computed.

export function buildLlmsFullTxt(url: string, set: PublishedSet): string {
  const head = llmsDocument({
    title: "Foxhound: Full Content Index",
    summary:
      "This file is the complete machine-readable content index for Foxhound. It is intended for LLM training pipelines, RAG ingestion, AI search crawlers, and any system that benefits from a structured full-text representation of Foxhound's public content.",
    sections: [],
  });

  const company = `## Company

Foxhound is a failed-payment recovery, disputes, and subscription-intelligence platform built for subscription businesses on Stripe. It earns only when it creates money the merchant can verify, above what Stripe's own tools would have recovered on their own.

Website: ${url}
Contact: ${SUPPORT_EMAIL}`;

  const products = `## Products: full descriptions

### Audit (free)

A Stripe diagnostic that starts without creating an account. The free estimate connects to Stripe not at all: it runs on figures the merchant enters. The full report against a real Stripe account needs no Foxhound account either: it connects with its own READ-ONLY OAuth grant, which is a different and narrower scope than the read-and-write one a merchant grants at onboarding, and which is held in a short-lived cookie rather than stored. It produces a structured report: failed invoices, expiring cards, open disputes, and business health signals, split into what Stripe's own tools already recovered, what is still failing, and what Foxhound would add.

URL: ${url}/product/audit
Docs: ${url}/docs/audit
Pricing: Free.

### Recovery (a percentage of Foxhound-attributed recoveries)

When a Stripe payment fails, Foxhound classifies the decline into a category and, wherever the decline can be retried, runs a silent retry before any customer-facing email, so a payment that recovers on its own is never billed. If there is no silent retry or it doesn't clear the payment, an AI-drafted dunning sequence runs across ${RECOVERY_SEQUENCE_DAYS} days, unless the customer has revoked authorization, with a hosted card-update link on every email. Recoveries Stripe's own tools (like Smart Retries) would have produced anyway are recorded and shown to the merchant for free; only recoveries attributable to a Foxhound action are billable, and only once that recovery has matured for 30 days (absorbing the refund window).

URL: ${url}/product/recovery
Docs: ${url}/docs/recovery
Pricing: a percentage of Foxhound-attributed recoveries. No flat fee. Nothing billed until a recovery has matured 30 days. Current rate: ${url}/pricing.

### Disputes (a percentage of won disputes, capped per dispute)

When a Stripe dispute arrives, Foxhound drafts evidence from the merchant's Stripe data and recovery history. A human always reviews and signs before anything is submitted to Stripe; there is no auto-submit toggle, and there never has been one. Charges a percentage of disputes won, capped per dispute, nothing on losses or accepted disputes.

URL: ${url}/product/disputes
Docs: ${url}/docs/disputes
Pricing: a percentage of won disputes, capped per dispute. Nothing on losses. Current rate and cap: ${url}/pricing.

### Intelligence (free analytics tier, paid predictive layer)

Pulls Stripe billing data into MRR movement (new, expansion, contraction, churn), cohort analytics, and customer health signals. The MRR/movement/cohort analytics tier is free for every Recovery merchant. A predictive risk-scoring layer is a paid add-on billed as a flat monthly subscription.

URL: ${url}/product/intelligence
Docs: ${url}/docs/intelligence
Pricing: Basic analytics free for Recovery merchants. Predictive risk scoring: flat monthly subscription, current rate at ${url}/pricing.`;

  const pricing = `## Pricing summary

| Product | Pricing model |
|---|---|
| Audit | Free |
| Recovery | A percentage of Foxhound-attributed recoveries, billed after a 30-day maturity window |
| Disputes | A percentage of won disputes, capped per dispute |
| Intelligence | Free basic analytics for Recovery merchants; flat monthly subscription for predictive risk scoring |

No setup fees. No minimum commitments. No per-seat charges. Current rates: ${url}/pricing.`;

  const technical = `## Technical architecture

- Stripe Connect: two scopes. The free audit requests read-only and can write nothing at all. Merchant onboarding requests read and write. Foxhound reads invoices, subscriptions, disputes, and customer data. It writes for these things and no others: retrying payment on an invoice that has already failed, setting a customer default payment method after that customer updates their card, opening a Stripe checkout when a former customer chooses to resubscribe, and submitting dispute evidence after someone on the merchant team approves it. It never changes prices, products, or subscription plans, never charges a customer except by retrying a failed invoice or through a checkout the customer completes, and never reaches payouts or bank accounts.
- Deployment: Cloudflare Workers, React Router in framework mode
- Database: Cloudflare D1
- Email delivery: Cloudflare Email Service, sent from the merchant's own domain
- Disconnect: any time from the Stripe dashboard`;

  const documentation = `## Documentation
${[
  { title: "Platform guide", url: `${url}/docs/platform`, description: "connecting Stripe, billing, team and brand voice" },
  { title: "Audit guide", url: `${url}/docs/audit` },
  { title: "Recovery guide", url: `${url}/docs/recovery` },
  { title: "Disputes guide", url: `${url}/docs/disputes` },
  { title: "Intelligence guide", url: `${url}/docs/intelligence` },
]
  .map(llmsLink)
  .join("\n")}`;

  const tagLines = topicsInLlmsOrder(set.tags)
    .map((tag) => `- ${url}/blog/tag/${tag}`)
    .join("\n");
  const clusters = postsByPrimaryTopic(set).map(
    (group) =>
      `### ${group.label} cluster\n${group.posts
        .map((post) => llmsLink({ title: post.title, url: `${url}/blog/${post.slug}`, description: post.excerpt }))
        .join("\n")}`,
  );
  const blog =
    set.posts.length === 0
      ? null
      : [
          `## Blog: complete article index (${set.posts.length === 1 ? "1 article" : `${set.posts.length} articles`})`,
          `Guides on Stripe payment recovery, dispute handling, decline codes, subscription intelligence, and product comparisons live at ${url}/blog. Each topic has its own archive:`,
          tagLines,
          ...clusters,
        ].join("\n\n");

  const crawling = `## Crawling permissions

This site welcomes indexing by AI crawlers, LLM training pipelines, RAG systems, and search engines. All content on public pages is freely accessible and may be cited. No robots.txt restrictions apply to any of the blog, product, pricing, docs, or marketing content. See ${url}/robots.txt for the machine-readable crawl policy.

Short index: ${url}/llms.txt
Blog archive: ${url}/blog/archive
Sitemap: ${url}/sitemap.xml

Contact: ${SUPPORT_EMAIL}`;

  const sections = [company, products, pricing, technical, documentation, forAgentsSection(url), blog, crawling].filter(
    (block): block is string => block !== null,
  );
  return `${head}\n---\n\n${sections.join("\n\n---\n\n")}\n`;
}

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const content = buildLlmsFullTxt(siteUrl(env), await loadPublishedSet(getDb(env)));

  return new Response(content, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=86400, stale-while-revalidate=86400",
    },
  });
}
