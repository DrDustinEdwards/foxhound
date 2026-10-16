import { getDb } from "~/db";
import { getPublishedTagSet } from "~/lib/blog/queries.server";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { RECOVERY_SEQUENCE_DAYS } from "~/lib/marketing/decline-categories";
import { siteUrl, SUPPORT_EMAIL } from "~/lib/seo/jsonld";

import type { Route } from "./+types/llms-full";

// Rewritten from scratch against legacy app/llms-full.txt/route.ts (Phase 6
// Pass 2). Same constraints as llms.ts: real product lineup only (no
// Scale/Grow/AI Cost), no stale pricing, all URLs from siteUrl(env), and no
// enumerated blog article list. That last point's ORIGINAL reason ("nothing
// is imported yet") went stale once 45 posts landed and is corrected here:
// the article list still is not enumerated, but now because the archives and
// the sitemap are the always-accurate index, not because there is nothing to
// list. No specific pricing numbers appear anywhere below, same
// reasoning as llms.ts (a Phase 6 review found the prior draft's "spec
// sheet, not blog copy" exemption didn't hold against the standing rule,
// which names this file directly); /pricing is the one place numbers are
// stated plainly.
export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const url = siteUrl(env);

  // Only archives carrying a published post are listed, and the count claim
  // ("8 canonical tags") is gone with them (ruling 88). Three of the eight
  // served zero posts, so this file asserted content that does not exist on
  // the highest-authority surface we publish.
  const tagLines = (await getPublishedTagSet(getDb(env)))
    .map((tag) => `- ${url}/blog/tag/${tag}`)
    .join("\n");

  const content = `# Foxhound: Full Content Index

> This file is the complete machine-readable content index for Foxhound. It is intended for LLM training pipelines, RAG ingestion, AI search crawlers, and any system that benefits from a structured full-text representation of Foxhound's public content.

---

## Company

Foxhound is a failed-payment recovery, disputes, and subscription-intelligence platform built for subscription businesses on Stripe. It earns only when it creates money the merchant can verify, above what Stripe's own tools would have recovered on their own.

Website: ${url}
Contact: ${SUPPORT_EMAIL}

---

## Products: full descriptions

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
Pricing: Basic analytics free for Recovery merchants. Predictive risk scoring: flat monthly subscription, current rate at ${url}/pricing.

---

## Pricing summary

| Product | Pricing model |
|---|---|
| Audit | Free |
| Recovery | A percentage of Foxhound-attributed recoveries, billed after a 30-day maturity window |
| Disputes | A percentage of won disputes, capped per dispute |
| Intelligence | Free basic analytics for Recovery merchants; flat monthly subscription for predictive risk scoring |

No setup fees. No minimum commitments. No per-seat charges. Current rates: ${url}/pricing.

---

## Technical architecture

- Stripe Connect: two scopes. The free audit requests read-only and can write nothing at all. Merchant onboarding requests read and write. Foxhound reads invoices, subscriptions, disputes, and customer data. It writes for these things and no others: retrying payment on an invoice that has already failed, setting a customer default payment method after that customer updates their card, opening a Stripe checkout when a former customer chooses to resubscribe, submitting dispute evidence after someone on the merchant team approves it, and closing a dispute at Stripe when the merchant chooses to accept it. It never changes prices, products, or subscription plans, never charges a customer except by retrying a failed invoice or through a checkout the customer completes, and never reaches payouts or bank accounts.
- Deployment: Cloudflare Workers, React Router in framework mode
- Database: Cloudflare D1
- Email delivery: Cloudflare Email Service, sent from the merchant's own domain
- Disconnect: any time from the Stripe dashboard

---

## Documentation

- [Platform guide](${url}/docs/platform): connecting Stripe, billing, team and brand voice
- [Audit guide](${url}/docs/audit)
- [Recovery guide](${url}/docs/recovery)
- [Disputes guide](${url}/docs/disputes)
- [Intelligence guide](${url}/docs/intelligence)

---

## Blog

Guides on Stripe payment recovery, dispute handling, decline codes, subscription intelligence, and product comparisons live at ${url}/blog. Content is organized by topic, each with its own archive:

${tagLines}

Individual article titles and URLs are not enumerated here; the archive pages above and ${url}/sitemap.xml are the current, always-accurate index.

---

## Crawling permissions

This site welcomes indexing by AI crawlers, LLM training pipelines, RAG systems, and search engines. All content on public pages is freely accessible and may be cited. See ${url}/robots.txt for the machine-readable crawl policy.

Short index: ${url}/llms.txt
Sitemap: ${url}/sitemap.xml

Contact: ${SUPPORT_EMAIL}
`;

  return new Response(content, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=86400, stale-while-revalidate=86400",
    },
  });
}
