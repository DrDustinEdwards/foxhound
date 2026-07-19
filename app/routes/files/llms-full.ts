import { cloudflareContext } from "~/lib/cloudflare-context";
import { siteUrl, SUPPORT_EMAIL } from "~/lib/seo/jsonld";

import type { Route } from "./+types/llms-full";

// Rewritten from scratch against legacy app/llms-full.txt/route.ts (Phase 6
// Pass 2). Same constraints as llms.ts: real product lineup only (no
// Scale/Grow/AI Cost), no stale pricing, all URLs from siteUrl(env), and no
// enumerated blog article list (see llms.ts's comment; nothing is imported
// yet, so a generic pointer to /blog and the tag archives is the honest
// choice here too).
export function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const url = siteUrl(env);

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

A Stripe diagnostic that runs without creating an account. Connects read-only to Stripe and produces a structured report: failed invoices, expiring cards, open disputes, and business health signals, split into what Stripe's own tools already recovered, what is still failing, and what Foxhound would add. No write access to Stripe, no signup required.

URL: ${url}/products/audit
Docs: ${url}/docs/audit
Pricing: Free.

### Recovery (20% of Foxhound-attributed recoveries)

When a Stripe payment fails, Foxhound classifies the decline into a category and runs a silent retry before any customer-facing email, so a payment that recovers on its own is never billed. If the silent retry doesn't clear it, an AI-drafted dunning sequence runs across 30 days, with a hosted card-update link on every email. Recoveries Stripe's own tools (like Smart Retries) would have produced anyway are recorded and shown to the merchant for free; only recoveries attributable to a Foxhound action are billable, and only once that recovery has matured for 30 days (absorbing the refund window).

URL: ${url}/products/recovery
Docs: ${url}/docs/recovery
Pricing: 20% of Foxhound-attributed recoveries. No flat fee. Nothing billed until a recovery has matured 30 days.

### Disputes (20% of won disputes, capped at $500)

When a Stripe dispute arrives, Foxhound drafts evidence from the merchant's Stripe data and recovery history. A human always reviews and signs before anything is submitted to Stripe; there is no auto-submit toggle, and there never has been one. Charges 20% of disputes won, capped at $500 per dispute, nothing on losses or accepted disputes.

URL: ${url}/products/disputes
Docs: ${url}/docs/disputes
Pricing: 20% of won disputes, capped at $500 per dispute. Nothing on losses.

### Intelligence (free analytics tier, $199/month predictive layer)

Pulls Stripe billing data into MRR movement (new, expansion, contraction, churn), cohort analytics, and customer health signals. The MRR/movement/cohort analytics tier is free for every Recovery merchant. A predictive risk-scoring layer, which feeds Recovery timing and Disputes triage, is a paid add-on.

URL: ${url}/products/intelligence
Docs: ${url}/docs/intelligence
Pricing: Basic analytics free for Recovery merchants. Predictive risk scoring: $199/month.

---

## Pricing summary

| Product | Pricing model |
|---|---|
| Audit | Free |
| Recovery | 20% of Foxhound-attributed recoveries, billed after a 30-day maturity window |
| Disputes | 20% of won disputes, capped at $500 per dispute |
| Intelligence | Free basic analytics for Recovery merchants; $199/month for predictive risk scoring |

No setup fees. No minimum commitments. No per-seat charges.

---

## Technical architecture

- Stripe Connect: read-only OAuth scope. Foxhound reads invoices, subscriptions, disputes, and customer data, and retries failed invoice payments through Stripe's own API (a Stripe-native action, not a write to customer data or billing configuration).
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

Guides on Stripe payment recovery, dispute handling, decline codes, subscription intelligence, SaaS pricing and metrics, and product comparisons live at ${url}/blog. Content is organized under 8 canonical tags, each with its own archive:

- ${url}/blog/tag/payment-recovery
- ${url}/blog/tag/disputes
- ${url}/blog/tag/subscription-intelligence
- ${url}/blog/tag/decline-codes
- ${url}/blog/tag/stripe-for-saas
- ${url}/blog/tag/saas-pricing
- ${url}/blog/tag/saas-metrics
- ${url}/blog/tag/comparisons

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
