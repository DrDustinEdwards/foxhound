import { getDb } from "~/db";
import { getPublishedTagSet } from "~/lib/blog/queries.server";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { CACHE_DIRECTIVES } from "~/lib/http/cache-policy";
import { RECOVERY_SEQUENCE_DAYS } from "~/lib/marketing/decline-categories";
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
export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const url = siteUrl(env);

  // Only archives that actually carry a published post are advertised
  // (ruling 88). This file previously listed all eight canonical tags, three
  // of which served zero posts, so the highest-authority surface we publish
  // was pointing AI crawlers at empty pages, and an unknown tag returns 200
  // rather than 404, making an empty archive indistinguishable from a garbage
  // URL. Legacy enumerates only topics that have articles; content-gating
  // matches it and self-corrects as roadmap content lands.
  const tagList = (await getPublishedTagSet(getDb(env)))
    .map((tag) => `${url}/blog/tag/${tag}`)
    .join(", ");

  const content = `# Foxhound

> Foxhound is a failed-payment recovery, disputes, and subscription-intelligence platform for Stripe merchants. Outcome-based pricing: it earns only when it creates money the merchant can verify, above what Stripe's own tools would have recovered anyway.

Foxhound is built on Stripe Connect for subscription businesses. It sits on top of Stripe and acts after a payment fails, a dispute opens, or a subscription's billing signals change. Foxhound asks Stripe for two different OAuth scopes, and which one it asks for depends on what it is doing. The free audit requests READ-ONLY access: it computes a diagnostic and can change nothing. Connecting a merchant account at /connect requests read and write, because retrying a failed invoice is a write. The write half is used for these things and no others: retrying payment on an invoice that has already failed, setting a customer default payment method after that customer updates their card, opening a Stripe checkout when a former customer chooses to resubscribe, submitting dispute evidence after someone on the merchant team approves it, and closing a dispute at Stripe when the merchant chooses to accept it. Foxhound never changes prices, products, or subscription plans, never charges a customer except by retrying a failed invoice or through a checkout the customer completes, and never reaches payouts or bank accounts.

## Products

- [Audit](${url}/product/audit): Free Stripe diagnostic. Identifies failed invoices, expiring cards, open disputes, and business health metrics. No account required.
- [Recovery](${url}/product/recovery): AI-drafted dunning email sequences and silent retries across ${RECOVERY_SEQUENCE_DAYS} days, calibrated by decline category. Recoveries Stripe's own tools would have gotten anyway are recorded and shown for free. Priced as a percentage of Foxhound-attributed recoveries only, and only once a recovery has matured 30 days. See ${url}/pricing for the current rate.
- [Disputes](${url}/product/disputes): Evidence drafted automatically from Stripe data and recovery history. A human always reviews and signs before anything reaches Stripe; there is no auto-submit toggle. Priced as a percentage of won disputes only, capped per dispute, nothing on losses. See ${url}/pricing for the current rate and cap.
- [Intelligence](${url}/product/intelligence): MRR, movement (new/expansion/contraction/churn), and cohort analytics are free for every Recovery merchant. The predictive risk-scoring layer is a flat monthly subscription. See ${url}/pricing for the current rate.

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

Guides on Stripe payment recovery, dispute handling, and subscription intelligence: [${url}/blog](${url}/blog). Browse by topic at ${tagList}.

## For agents

Foxhound exposes a Model Context Protocol endpoint at ${url}/mcp, so an AI agent can read a merchant's own Foxhound data on their behalf. A merchant generates a key under Settings and API keys inside their account and gives it to the agent as a bearer token; the key decides which account the agent reads, one key to one account, always the one that issued it.

Most tools read: audit runs, the recovery queue, disputes, the billing ledger and invoices, the recurring-revenue overview, churn, customers, alerts, connected Stripe accounts, and the brand voice and merchant context an agent can also write. Two tools write, and only to settings: the audit lookback and monthly report, the win-back and expiring-card features, notification email and Slack webhook and toggles, the sender name and the brand voice on a connected Stripe account, the merchant context the recovery-email writer is given, and alerts, which can be created, switched off and deleted. Each write runs the same validation the settings page runs and is recorded with the key that made it, the tool used and the field names touched, never the values. A field left out of the brand voice or the merchant context is left as it is and only an empty value clears one; the notification settings are replaced as a whole.

There is no tool that submits dispute evidence, cancels an account, disconnects Stripe, issues another key or moves money: those do not exist rather than being switched off.

Customer names are never sent through the endpoint and email addresses are masked to their first character and domain. The Stripe customer id comes through whole, so an agent can correlate and ask a follow-up question without being able to contact anybody.

## Technical

- Built on Stripe Connect. The free audit requests a read-only OAuth scope; merchant onboarding requests read and write, and the writes are invoice retries, default payment method updates, win-back resubscribe checkouts, approved dispute evidence, and disputes the merchant chooses to accept
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
      "Cache-Control": CACHE_DIRECTIVES.files,
    },
  });
}
