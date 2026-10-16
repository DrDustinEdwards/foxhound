import { llmsDocument, llmsLink, type LlmsLink } from "@drdustinedwards/site-helpers/llms";

import { getDb } from "~/db";
import { postsByTopic, topicsInLlmsOrder, type PublishedSet } from "~/lib/blog/published-set";
import { loadPublishedSet } from "~/lib/blog/published-set.server";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { RECOVERY_SEQUENCE_DAYS } from "~/lib/marketing/decline-categories";
import { siteUrl, SUPPORT_EMAIL } from "~/lib/seo/jsonld";

import type { Route } from "./+types/llms";

// /llms.txt (row F3, J61). Recova's app/llms.txt/route.ts is the spec for the
// file's shape and sections, in its order: Products, Pricing, Key pages,
// Documentation, the blog by topic with every article listed, the MCP section,
// Technical, Crawling permissions. The skeleton and every link line are
// Prelum's (Q2): llmsDocument for the title, summary, intro and Products, and
// llmsLink for each later list, because llmsDocument takes link lists only and
// Recova puts prose sections (Pricing, MCP, Technical) between them.
//
// The facts are Foxhound's, never Recova's (RULES.md 2.1): Recova's copy
// described dead products, a stale price and a read-only scope Foxhound does not
// ask for. No specific pricing numbers appear (PRICING.md names this file);
// /pricing is where numbers are stated. Recova's hand-typed "Updated:" date is
// not carried, because a machine-read file never carries an invented date
// (RULES.md 2.6).
//
// The articles come from the one published set the sitemaps and feeds read
// (app/lib/blog/published-set.ts), so this file cannot list a post they do
// not, and a topic only a draft carries is never advertised (ruling 88). The
// counts are computed: Recova's hand-typed "(19 articles)" sat over a list of
// fourteen.

/** The MCP section, shared with llms-full.txt (Recova's "MCP connector"). */
export function forAgentsSection(url: string): string {
  return `## For agents

Foxhound exposes a Model Context Protocol endpoint at ${url}/mcp, so an AI agent can read a merchant's own Foxhound data on their behalf. A merchant generates a key under Settings and API keys inside their account and gives it to the agent as a bearer token; the key decides which account the agent reads, one key to one account, always the one that issued it.

Most tools read: audit runs, the recovery queue, disputes, the billing ledger and invoices, the recurring-revenue overview, churn, customers, alerts, connected Stripe accounts, and the brand voice and merchant context an agent can also write. Two tools write, and only to settings: the audit lookback and monthly report, the win-back and expiring-card features, notification email and Slack webhook and toggles, the sender name and the brand voice on a connected Stripe account, the merchant context the recovery-email writer is given, and alerts, which can be created, switched off and deleted. Each write runs the same validation the settings page runs and is recorded with the key that made it, the tool used and the field names touched, never the values. A field left out of the brand voice or the merchant context is left as it is and only an empty value clears one; the notification settings are replaced as a whole.

There is no tool that submits dispute evidence, cancels an account, disconnects Stripe, issues another key or moves money: those do not exist rather than being switched off.

Customer names are never sent through the endpoint and email addresses are masked to their first character and domain. The Stripe customer id comes through whole, so an agent can correlate and ask a follow-up question without being able to contact anybody.`;
}

function linkList(heading: string, links: LlmsLink[]): string {
  return `${heading}\n${links.map(llmsLink).join("\n")}`;
}

function articleCount(n: number): string {
  return n === 1 ? "1 article" : `${n} articles`;
}

export function buildLlmsTxt(url: string, set: PublishedSet): string {
  const head = llmsDocument({
    title: "Foxhound",
    summary:
      "Foxhound is a failed-payment recovery, disputes, and subscription-intelligence platform for Stripe merchants. Outcome-based pricing: it earns only when it creates money the merchant can verify, above what Stripe's own tools would have recovered anyway.",
    intro: [
      "Foxhound is built on Stripe Connect for subscription businesses. It sits on top of Stripe and acts after a payment fails, a dispute opens, or a subscription's billing signals change. Foxhound asks Stripe for two different OAuth scopes, and which one it asks for depends on what it is doing. The free audit requests READ-ONLY access: it computes a diagnostic and can change nothing. Connecting a merchant account at /connect requests read and write, because retrying a failed invoice is a write. The write half is used for these things and no others: retrying payment on an invoice that has already failed, setting a customer default payment method after that customer updates their card, opening a Stripe checkout when a former customer chooses to resubscribe, and submitting dispute evidence after someone on the merchant team approves it. Foxhound never changes prices, products, or subscription plans, never charges a customer except by retrying a failed invoice or through a checkout the customer completes, and never reaches payouts or bank accounts.",
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
            description: `AI-drafted dunning email sequences and silent retries across ${RECOVERY_SEQUENCE_DAYS} days, calibrated by decline category. Recoveries Stripe's own tools would have gotten anyway are recorded and shown for free. Priced as a percentage of Foxhound-attributed recoveries only, and only once a recovery has matured 30 days. See ${url}/pricing for the current rate.`,
          },
          {
            title: "Disputes",
            url: `${url}/product/disputes`,
            description: `Evidence drafted automatically from Stripe data and recovery history. A human always reviews and signs before anything reaches Stripe; there is no auto-submit toggle. Priced as a percentage of won disputes only, capped per dispute, nothing on losses. See ${url}/pricing for the current rate and cap.`,
          },
          {
            title: "Intelligence",
            url: `${url}/product/intelligence`,
            description: `MRR, movement (new/expansion/contraction/churn), and cohort analytics are free for every Recovery merchant. The predictive risk-scoring layer is a flat monthly subscription. See ${url}/pricing for the current rate.`,
          },
        ],
      },
    ],
  });

  const pricing = `## Pricing
- Audit: free, no account required
- Recovery: a percentage of Foxhound-attributed recoveries, billed only after a 30-day maturity window; baseline recoveries Stripe would have gotten anyway are never billed
- Disputes: a percentage of won disputes, capped per dispute, nothing on losses
- Intelligence: basic MRR/movement/cohort analytics free for Recovery merchants; predictive risk scoring is a flat monthly subscription
- No setup fees, no per-seat charges
- Current rates: ${url}/pricing`;

  const keyPages = linkList("## Key pages", [
    { title: "Homepage", url },
    { title: "Products overview", url: `${url}/products` },
    { title: "Pricing", url: `${url}/pricing` },
    { title: "Features", url: `${url}/features` },
    { title: "Demos", url: `${url}/demos` },
    { title: "Docs", url: `${url}/docs` },
    { title: "Free audit", url: `${url}/audit` },
    { title: "Blog", url: `${url}/blog` },
    { title: "All articles", url: `${url}/blog/archive` },
  ]);

  const documentation = linkList("## Documentation", [
    { title: "Platform guide", url: `${url}/docs/platform` },
    { title: "Recovery guide", url: `${url}/docs/recovery` },
    { title: "Disputes guide", url: `${url}/docs/disputes` },
    { title: "Intelligence guide", url: `${url}/docs/intelligence` },
    { title: "Audit guide", url: `${url}/docs/audit` },
  ]);

  // Only archives that carry a published post are advertised (ruling 88).
  const tagList = topicsInLlmsOrder(set.tags)
    .map((tag) => `${url}/blog/tag/${tag}`)
    .join(", ");
  const topics = postsByTopic(set).map((group) =>
    linkList(
      `### ${group.label} (${articleCount(group.posts.length)})`,
      group.posts.map((post) => ({ title: post.title, url: `${url}/blog/${post.slug}` })),
    ),
  );
  const blog =
    set.posts.length === 0
      ? null
      : [
          `## Blog by topic`,
          `Guides on Stripe payment recovery, dispute handling, and subscription intelligence: [${url}/blog](${url}/blog). Browse by topic at ${tagList}.`,
          ...topics,
        ].join("\n\n");

  const technical = `## Technical
- Built on Stripe Connect. The free audit requests a read-only OAuth scope; merchant onboarding requests read and write, and the writes are invoice retries, default payment method updates, win-back resubscribe checkouts, and approved dispute evidence
- Hosted on Cloudflare Workers, database on Cloudflare D1
- No card data stored; all payment processing goes through Stripe
- Disconnect any time from the Stripe dashboard`;

  const crawling = `## Crawling permissions

This site welcomes indexing by AI crawlers, LLM training pipelines, RAG systems, and search engines. All content on public pages is freely accessible and may be cited.

Full content: ${url}/llms-full.txt

Contact: ${SUPPORT_EMAIL}`;

  const rest = [pricing, keyPages, documentation, blog, forAgentsSection(url), technical, crawling].filter(
    (block): block is string => block !== null,
  );
  return `${head}\n${rest.join("\n\n")}\n`;
}

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const content = buildLlmsTxt(siteUrl(env), await loadPublishedSet(getDb(env)));

  return new Response(content, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=86400, stale-while-revalidate=86400",
    },
  });
}
