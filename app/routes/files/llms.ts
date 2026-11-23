import { STRIPE_WRITES, STRIPE_WRITES_LIMITS } from "~/lib/marketing/trust-copy";
import { INTELLIGENCE_FREE_SENTENCE } from "~/lib/marketing/pricing-copy";
import { llmsResponse } from "@drdustinedwards/site-helpers/llms";
import { getDb } from "~/db";
import { getPublishedTagSet } from "~/lib/blog/queries.server";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import { RECOVERY_SEQUENCE_DAYS } from "~/lib/marketing/decline-categories";
import { siteUrl, SUPPORT_EMAIL } from "~/lib/seo/jsonld";
import { RECOVERY_MATURITY_DAYS } from "~/lib/constants";
import {
  AUDIT_ACCESS_ASK,
  AUDIT_ACCESS_PROMISE,
  AUDIT_GRANT_MINUTES,
} from "~/lib/marketing/audit-access";

import type { Route } from "./+types/llms";

// Describes Foxhound's real, current lineup only. No specific pricing numbers appear anywhere below (PRICING.md: no specific-number pricing in blog/SEO copy, "outcome-based pricing" framing): the risk, an AI citing a stale number as current fact, applies as much to a spec sheet as to prose. /pricing and the product pages are where numbers are stated plainly. The blog section deliberately does NOT enumerate article titles/URLs: pointing at /blog and /blog/tag/* is honest and needs no follow-up edit as posts land.
export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const url = siteUrl(env);

  // Only archives that actually carry a published post are advertised, so AI crawlers are never pointed at empty pages.
  const tagList = (await getPublishedTagSet(getDb(env)))
    .map((tag) => `${url}/blog/tag/${tag}`)
    .join(", ");

  return llmsResponse({
    origin: url,
    request,
    title: "Foxhound",
    summary:
      "Foxhound is a failed-payment recovery, disputes, and subscription-intelligence platform for Stripe merchants. Outcome-based pricing: it earns only when it creates money the merchant can verify, above what Stripe's own tools would have recovered anyway.",
    intro: [
      `Foxhound is built on Stripe Connect for subscription businesses. It sits on top of Stripe and acts after a payment fails, a dispute opens, or a subscription's billing signals change. For the free audit, ${AUDIT_ACCESS_ASK} ${AUDIT_ACCESS_PROMISE} Connecting a merchant account at /connect also requests read and write, because retrying a failed invoice is a write. On a connected account the write half is used for these things and no others: ${STRIPE_WRITES}. Foxhound ${STRIPE_WRITES_LIMITS}.`,
    ],
    sections: [
      {
        heading: "Products",
        links: [
          {
            title: "Audit",
            url: `${url}/product/audit`,
            description:
              "Free Stripe diagnostic. Identifies failed invoices, expiring cards, open disputes, and business health metrics. No account required.",
          },
          {
            title: "Recovery",
            url: `${url}/product/recovery`,
            description: `AI-drafted dunning email sequences and silent retries across ${RECOVERY_SEQUENCE_DAYS} days, calibrated by decline category. Recoveries Stripe's own tools would have gotten anyway are recorded and shown for free. Priced as a percentage of Foxhound-attributed recoveries only, and only once a recovery has matured ${RECOVERY_MATURITY_DAYS} days. See ${url}/pricing for the current rate.`,
          },
          {
            title: "Disputes",
            url: `${url}/product/disputes`,
            description: `Evidence drafted automatically from Stripe data and recovery history. A person reviews and signs each submission, or turns on auto-submit (off by default) to submit 24 hours before the deadline. Priced as a percentage of won disputes only, capped per dispute, nothing on losses. See ${url}/pricing for the current rate and cap.`,
          },
          {
            title: "Intelligence",
            url: `${url}/product/intelligence`,
            description: `MRR, movement (new/expansion/contraction/churn), and cohort analytics are part of Intelligence. ${INTELLIGENCE_FREE_SENTENCE}`,
          },
        ],
      },
      {
        heading: "Pricing",
        body: [
          [
            "- Audit: free, no account required",
            `- Recovery: a percentage of Foxhound-attributed recoveries, billed only after a ${RECOVERY_MATURITY_DAYS}-day maturity window; baseline recoveries Stripe would have gotten anyway are never billed`,
            "- Disputes: a percentage of won disputes, capped per dispute, nothing on losses",
            `- Intelligence: ${INTELLIGENCE_FREE_SENTENCE}`,
            "- No setup fees, no per-seat charges",
            `- Current rates: ${url}/pricing`,
          ].join("\n"),
        ],
      },
      {
        heading: "Key pages",
        links: [
          { title: "Homepage", url },
          { title: "Products overview", url: `${url}/products` },
          { title: "Pricing", url: `${url}/pricing` },
          { title: "Demos", url: `${url}/demos` },
          { title: "Docs", url: `${url}/docs` },
          { title: "Free audit", url: `${url}/audit` },
          { title: "Blog", url: `${url}/blog` },
        ],
      },
      {
        heading: "Documentation",
        links: [
          { title: "Platform guide", url: `${url}/docs/platform` },
          { title: "Recovery guide", url: `${url}/docs/recovery` },
          { title: "Disputes guide", url: `${url}/docs/disputes` },
          { title: "Intelligence guide", url: `${url}/docs/intelligence` },
          { title: "Audit guide", url: `${url}/docs/audit` },
        ],
      },
      {
        heading: "Blog",
        body: [
          `Guides on Stripe payment recovery, dispute handling, and subscription intelligence: [${url}/blog](${url}/blog). Browse by topic at ${tagList}.`,
        ],
      },
      {
        heading: "For agents",
        body: [
          `Foxhound exposes a Model Context Protocol endpoint at ${url}/mcp, so an AI agent can read a merchant's own Foxhound data on their behalf. A merchant generates a key under Settings and API keys inside their account and gives it to the agent as a bearer token; the key decides which account the agent reads, one key to one account, always the one that issued it.`,
          "Most tools read: audit runs, the recovery queue, disputes, the billing ledger and invoices, the recurring-revenue overview, churn, customers, alerts, connected Stripe accounts, and the brand voice and merchant context an agent can also write. Two tools write, and only to settings: the audit lookback and monthly report, the win-back and expiring-card features, notification email and Slack webhook and toggles, the sender name and the brand voice on a connected Stripe account, the merchant context the recovery-email writer is given, and alerts, which can be created, switched off and deleted. Each write runs the same validation the settings page runs and is recorded with the key that made it, the tool used and the field names touched, never the values. A field left out of the brand voice or the merchant context is left as it is and only an empty value clears one; the notification settings are replaced as a whole.",
          "There is no tool that submits dispute evidence, cancels an account, disconnects Stripe, issues another key or moves money: those do not exist rather than being switched off.",
          "Customer names are never sent through the endpoint and email addresses are masked to their first character and domain. The Stripe customer id comes through whole, so an agent can correlate and ask a follow-up question without being able to contact anybody.",
        ],
      },
      {
        heading: "Technical",
        body: [
          [
            `- Built on Stripe Connect. The free audit and merchant onboarding both request read and write, because Stripe no longer offers read-only to platforms. The audit only reads, and disconnects itself after ${AUDIT_GRANT_MINUTES} minutes. On a connected account the writes are invoice retries, default payment method updates, win-back resubscribe checkouts, approved dispute evidence, and disputes the merchant chooses to accept`,
            "- Hosted on Cloudflare Workers, database on Cloudflare D1",
            "- No card data stored; all payment processing goes through Stripe",
            "- Disconnect any time from the Stripe dashboard",
          ].join("\n"),
        ],
      },
      {
        heading: "Crawling permissions",
        body: [
          "This site welcomes indexing by AI crawlers, LLM training pipelines, RAG systems, and search engines. All content on public pages is freely accessible and may be cited.",
          `Full content: ${url}/llms-full.txt`,
          `Contact: ${SUPPORT_EMAIL}`,
        ],
      },
    ],
  });
}
