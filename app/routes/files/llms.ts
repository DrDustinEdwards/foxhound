import { cloudflareContext } from "~/lib/cloudflare-context";
import { siteUrl, SUPPORT_EMAIL } from "~/lib/seo/jsonld";

import type { Route } from "./+types/llms";

// Rewritten from scratch against legacy app/llms.txt/route.ts (Phase 6 Pass
// 2), NOT ported verbatim: legacy described dead products (Scale, Grow, AI
// Cost) and the stale $299/mo figure the task bans outright. This describes
// Foxhound's real, current lineup only. No specific pricing numbers appear
// anywhere below (standing rule, PRICING.md: "no specific-number pricing in
// blog/SEO copy... 'outcome-based pricing' framing"; TASK-foxhound-phase6.md
// names llms.txt/llms-full.txt directly). A prior draft stated the actual
// figures here on the theory that a machine-readable spec sheet is exempt
// from the blog/SEO-copy rule; a Phase 6 review found that reasoning
// doesn't hold (the rule names this file explicitly, and the risk it guards
// against, an AI citing a stale number as current fact, applies just as
// much to a spec sheet as to prose). /pricing and the product pages remain
// the place numbers are stated plainly.
//
// The blog section deliberately does NOT enumerate article titles/URLs:
// no posts are imported yet (STOP A lands separately), so a static list
// here would either be empty noise or a stale/aspirational claim. Pointing
// at /blog and /blog/tag/* is honest today and needs no follow-up edit
// once the import lands.
export function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const url = siteUrl(env);

  const content = `# Foxhound

> Foxhound is a failed-payment recovery, disputes, and subscription-intelligence platform for Stripe merchants. Outcome-based pricing: it earns only when it creates money the merchant can verify, above what Stripe's own tools would have recovered anyway.

Foxhound is built on Stripe Connect for subscription businesses. It sits on top of Stripe and acts after a payment fails, a dispute opens, or a subscription's billing signals change. Read-only Stripe OAuth scope: Foxhound never modifies billing configuration, payment methods, or subscription logic.

## Products

- [Audit](${url}/products/audit): Free Stripe diagnostic. Identifies failed invoices, expiring cards, open disputes, and business health metrics. No account required.
- [Recovery](${url}/products/recovery): Silent retries first, then AI-drafted dunning email sequences across 30 days, calibrated by decline category. Recoveries Stripe's own tools would have gotten anyway are recorded and shown for free. Priced as a percentage of Foxhound-attributed recoveries only, and only once a recovery has matured 30 days. See ${url}/pricing for the current rate.
- [Disputes](${url}/products/disputes): Evidence drafted automatically from Stripe data and recovery history. A human always reviews and signs before anything reaches Stripe; there is no auto-submit toggle. Priced as a percentage of won disputes only, capped per dispute, nothing on losses. See ${url}/pricing for the current rate and cap.
- [Intelligence](${url}/products/intelligence): MRR, movement (new/expansion/contraction/churn), and cohort analytics are free for every Recovery merchant. The predictive risk-scoring layer is a flat monthly subscription. See ${url}/pricing for the current rate.

## Pricing

- Audit: free, no account required
- Recovery: a percentage of Foxhound-attributed recoveries, billed only after a 30-day maturity window; baseline recoveries Stripe would have gotten anyway are never billed
- Disputes: a percentage of won disputes, capped per dispute, nothing on losses
- Intelligence: basic MRR/movement/cohort analytics free for Recovery merchants; predictive risk scoring is a flat monthly subscription
- No setup fees, no per-seat charges
- Current rates: ${url}/pricing

## Key pages

- [Homepage](${url})
- [Products overview](${url}/products)
- [Pricing](${url}/pricing)
- [Demos](${url}/demos)
- [Docs](${url}/docs)
- [Free audit](${url}/audit)
- [Blog](${url}/blog)

## Documentation

- [Platform guide](${url}/docs/platform)
- [Recovery guide](${url}/docs/recovery)
- [Disputes guide](${url}/docs/disputes)
- [Intelligence guide](${url}/docs/intelligence)
- [Audit guide](${url}/docs/audit)

## Blog

Guides on Stripe payment recovery, dispute handling, and subscription intelligence: [${url}/blog](${url}/blog). Browse by topic at ${url}/blog/tag/payment-recovery, ${url}/blog/tag/disputes, ${url}/blog/tag/subscription-intelligence, ${url}/blog/tag/decline-codes, ${url}/blog/tag/stripe-for-saas, ${url}/blog/tag/saas-pricing, ${url}/blog/tag/saas-metrics, and ${url}/blog/tag/comparisons.

## Technical

- Built on Stripe Connect (read-only OAuth scope)
- Hosted on Cloudflare Workers, database on Cloudflare D1
- No card data stored; all payment processing goes through Stripe
- Disconnect any time from the Stripe dashboard

## Crawling permissions

This site welcomes indexing by AI crawlers, LLM training pipelines, RAG systems, and search engines. All content on public pages is freely accessible and may be cited.

Full content: ${url}/llms-full.txt

Contact: ${SUPPORT_EMAIL}
`;

  return new Response(content, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=86400, stale-while-revalidate=86400",
    },
  });
}
