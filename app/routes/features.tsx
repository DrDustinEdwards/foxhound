import { useState } from "react";
import { Link } from "react-router";

import { HealthScoreBadge } from "~/components/docs/health-score-badge";
import { SequenceTimeline } from "~/components/docs/sequence-timeline";
import { MarketingPageHeader } from "~/components/marketing-page-header";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { breadcrumbListJsonLd, siteUrl } from "~/lib/seo/jsonld";
import { marketingMeta } from "~/lib/seo/meta";

import type { Route } from "./+types/features";
import {
  DECLINE_CATEGORY_COUNT_WORD,
  DECLINE_CATEGORY_COUNT_WORD_LOWER,
  DECLINE_CATEGORY_PHRASE,
} from "~/lib/marketing/decline-categories";

// Ported from legacy /features (recova-eta.vercel.app/features), restored as
// a public route per the 2026-07-22 parity-over-consolidation amendment
// (ROUTES.md; this overrides the Phase 6 call to fold it into /products).
// Legacy's 129 entries span its own Supabase/Resend/Upstash/Vercel/MCP stack
// and several claims Foxhound's rebuild does not make (a numeric dispute
// fight/accept score, per-account alert-threshold configuration, an
// auto-run audit toggle). Every entry below is grounded in this repo's real
// code (app/lib/cron/registry.ts, app/db/schema.ts, app/lib/stripe/
// encryption.ts, the four /products/* pages) rather than carried over
// verbatim; legacy-only infrastructure claims are dropped, not renamed.

type Tag = "platform" | "audit" | "recovery" | "disputes" | "intelligence";

const TAG_LABEL: Record<Tag, string> = {
  platform: "Platform",
  audit: "Audit",
  recovery: "Recovery",
  disputes: "Disputes",
  intelligence: "Intelligence",
};

const FILTERS = ["All", "Platform", "Audit", "Recovery", "Disputes", "Intelligence"] as const;

type FilterValue = (typeof FILTERS)[number];

// Legacy colour-codes the product tag per product (components/features/
// FeatureCard.tsx's local ProductTag). Deliberately NOT the shared Badge:
// legacy hand-rolls this pill local to the card, Badge is the app-surface
// status pill on 20+ other carriers, and routing this onto it rendered every
// tag neutral grey and uppercased, which legacy never does.
const PRODUCT_TAG_CLASS: Record<Tag, string> = {
  recovery: "border-brand bg-brand-bg text-brand-text",
  disputes: "border-blue bg-blue-bg text-cobalt-text",
  intelligence: "border-green bg-green-bg text-green",
  audit: "border-border bg-surface2 text-text-tertiary",
  platform: "border-border bg-surface2 text-text-tertiary",
};

// CSS-only filter, ported from legacy's mechanism rather than just its rules.
// FeatureFilterShell sets data-feature-filter on the wrapper and these
// selectors hide any card whose data-product does not match. No per-card
// state, no re-render, and every card stays server-rendered and crawlable.
// Foxhound's CSP allows this: style-src is 'self' 'unsafe-inline'.
const FILTER_CSS = `
[data-feature-filter="Recovery"] [data-product]:not([data-product="Recovery"]) { display: none; }
[data-feature-filter="Disputes"] [data-product]:not([data-product="Disputes"]) { display: none; }
[data-feature-filter="Intelligence"] [data-product]:not([data-product="Intelligence"]) { display: none; }
[data-feature-filter="Audit"] [data-product]:not([data-product="Audit"]) { display: none; }
[data-feature-filter="Platform"] [data-product]:not([data-product="Platform"]) { display: none; }
`.trim();

function ProductTag({ tag }: { tag: Tag }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 font-mono text-tag font-medium ${PRODUCT_TAG_CLASS[tag]}`}
    >
      {TAG_LABEL[tag]}
    </span>
  );
}

interface Feature {
  title: string;
  tag: Tag;
  body: string;
}

interface Category {
  heading: string;
  features: Feature[];
}

// Section anchors are slugified from Foxhound's OWN headings below, never
// carried over from legacy's features-data.ts (ruling 38).
function sectionId(heading: string): string {
  return heading.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// Legacy renders an inline example inside three sections, keyed by section id
// (features/page.tsx's SectionInlineExample). Two are restored here now that
// their components exist (rulings 78/79), which discharges the matching part of
// M10's remainder. The THIRD, legacy's visibility stat grid, stays unbuilt: its
// 26.6% and $6,884 are legacy's figures, so whether Foxhound shows its own
// numbers or none is the copy pass's call under ruling 20d (ruling 77).
//
// The threshold sentence states FOXHOUND's bands, not legacy's. Legacy's reads
// "red below 34, [accent] 34-66, green at or above 67", which is false here; this
// is the sanctioned truthfulness class, not a copy rewrite.
function SectionInlineExample({ id }: { id: string }) {
  if (id === "automation") {
    return <SequenceTimeline category="soft" />;
  }
  if (id === "intelligence") {
    return (
      <div className="my-6 flex items-center gap-3 text-label text-text-secondary">
        <HealthScoreBadge score={20} />
        <HealthScoreBadge score={50} />
        <HealthScoreBadge score={82} />
        <span>red below 40, orange 40-69, green at or above 70.</span>
      </div>
    );
  }
  return null;
}

const CATEGORIES: Category[] = [
  {
    heading: "Automation",
    features: [
      {
        title: "Recovery tick, every 5 minutes",
        tag: "recovery",
        body: "Sweeps due recovery steps and runs each through its executor. No delay beyond the tick interval from any scheduled step.",
      },
      {
        title: "Silent retry before any email",
        tag: "recovery",
        body: "The decline is classified first. A quiet retry runs before a customer ever sees a dunning email.",
      },
      {
        title: "Fraud declines are never retried",
        tag: "recovery",
        body: "A fraud-category decline gets a single email and no retry step at all.",
      },
      {
        title: "Monthly recovery billing run",
        tag: "platform",
        body: "Invoices the prior month's matured (30+ day) recoveries at 20%. Baseline recoveries Stripe would have gotten anyway are never billed.",
      },
      {
        title: "Nightly Intelligence scoring and narrative",
        tag: "intelligence",
        body: "Health scores, predictions, alerts, and a structurally grounded AI narrative are computed nightly for every customer.",
      },
      {
        title: "Monthly MRR and movement snapshots",
        tag: "intelligence",
        body: "MRR and the movement waterfall (new, expansion, reactivation, contraction, churn) are computed from Stripe subscription data.",
      },
      {
        title: "Evidence drafted the moment a dispute opens",
        tag: "disputes",
        body: "Prior charges, recovery history, and Stripe signals are assembled into a draft automatically, before you open the dispute.",
      },
      {
        title: "Daily retention sweeps",
        tag: "platform",
        body: "Engagement events, email sends, webhook events, health-score history, cron history, and AI call logs are pruned on a schedule so operational tables stay bounded.",
      },
      {
        title: "Nightly demo reset",
        tag: "platform",
        body: "Demo accounts are reseeded nightly and never touch live Stripe data.",
      },
      {
        title: "Per-cron overlap prevention",
        tag: "platform",
        body: "Each cron takes a Durable Object lock before it runs. Overlapping runs are blocked, not queued, and every run is logged.",
      },
    ],
  },
  {
    heading: "Intelligence",
    features: [
      {
        title: "Free MRR analytics for every Recovery merchant",
        tag: "intelligence",
        body: "MRR and movements come free the moment Recovery connects. Not a trial, no separate signup.",
      },
      {
        title: "Predictive risk scoring, $199/mo",
        tag: "intelligence",
        body: "A paid layer on top of the free analytics that scores customers by churn risk before it happens.",
      },
      {
        title: `${DECLINE_CATEGORY_COUNT_WORD} decline categories, ${DECLINE_CATEGORY_COUNT_WORD_LOWER} sequences`,
        tag: "recovery",
        body: `Every Stripe decline code maps to ${DECLINE_CATEGORY_PHRASE}. Timing and retry strategy differ by category.`,
      },
      {
        title: "Fail-closed on unrecognized declines",
        tag: "recovery",
        body: "An unknown decline code defaults to a dedicated non-retryable category instead of silently auto-retrying.",
      },
      {
        title: "Evidence never fabricated",
        tag: "disputes",
        body: "Every drafted claim is grounded in real charge, email, and Stripe-signal data. Nothing is invented to strengthen a case.",
      },
    ],
  },
  {
    heading: "Email and communication",
    features: [
      {
        title: "AI-drafted sequences in your voice",
        tag: "recovery",
        body: "Recovery emails read as your brand voice, not Foxhound's. Every generated email is read in full before a template ships.",
      },
      {
        title: "Cloudflare Email Service delivery",
        tag: "platform",
        body: "Outbound email goes through Cloudflare's Email Service behind one thin send module business logic never bypasses.",
      },
      {
        title: "First-party open and click tracking",
        tag: "platform",
        body: "Engagement comes from Foxhound's own tracking routes, not a vendor webhook.",
      },
      {
        title: "Bounce and suppression handling",
        tag: "platform",
        body: "Email Service events flow through a queue consumer that updates the suppression list automatically.",
      },
      {
        title: "Signed one-click unsubscribe",
        tag: "platform",
        body: "CAN-SPAM-compliant, token-based, no login required.",
      },
      {
        title: "Hosted card-update page",
        tag: "recovery",
        body: "A no-login page a customer reaches from a recovery email to update an expiring or failed card.",
      },
    ],
  },
  {
    heading: "Visibility",
    features: [
      {
        title: "Billing evidence ledger",
        tag: "platform",
        body: "Every fee renders its chain: the Foxhound action, the recovered payment, the 20%. Baseline recoveries appear in the same ledger marked free.",
      },
      {
        title: "Dispute review-and-sign screen",
        tag: "disputes",
        body: "The full evidence draft, an edit affordance, and an explicit approve-and-submit action with the fee, capped at $500, stated on the button.",
      },
      {
        title: "Audit report",
        tag: "audit",
        body: "One headline lift number, three bands beneath it: Stripe recovered, still dying, Foxhound adds.",
      },
      {
        title: "Intelligence risk view",
        tag: "intelligence",
        body: "Every customer scored, sorted by MRR at risk, each score expandable to its evidence.",
      },
      {
        title: "Hand-rolled SVG charts",
        tag: "platform",
        body: "Sparkline, line and area, bar and waterfall, meter, and cohort grid. Server-rendered, no client-only measurement container, no hydration flash.",
      },
      {
        title: "Admin operations and cron health",
        tag: "platform",
        body: "D1 cap telemetry, deploy state, and a live cron-status table.",
      },
    ],
  },
  {
    heading: "Control",
    features: [
      {
        title: "Pause, resume, or cancel a sequence",
        tag: "recovery",
        body: "From the payment detail page, along with triggering an immediate retry at any time.",
      },
      {
        title: "Edit drafted dispute evidence",
        tag: "disputes",
        body: "Any drafted field can be edited before approval. The draft is a starting point, not a constraint.",
      },
      {
        title: "Durable Object rate limiting",
        tag: "platform",
        body: "Rate limits are enforced through a dedicated Durable Object, not a third-party rate-limit service.",
      },
      {
        title: "Theme toggle",
        tag: "platform",
        body: "Dark by default, light as a first-class mode, cookie-persisted with no flash.",
      },
    ],
  },
  {
    heading: "Integration",
    features: [
      {
        title: "Stripe Connect OAuth",
        tag: "platform",
        body: "Connects in under a minute, and never touches your billing configuration.",
      },
      {
        title: "Direct platform invoicing",
        tag: "platform",
        body: "Foxhound bills merchants directly as its own Stripe customer. This is not a Connect application fee.",
      },
      {
        title: "Cloudflare D1 and Drizzle",
        tag: "platform",
        body: "The database layer, reached through native Workers bindings, never over HTTP.",
      },
      {
        title: "Sentry error tracking",
        tag: "platform",
        body: "Error tracking with source maps across the Worker and its cron jobs.",
      },
    ],
  },
  {
    heading: "Security and compliance",
    features: [
      {
        title: "Narrow Stripe scope",
        tag: "platform",
        body: "Foxhound requests read and write Stripe Connect access, because retrying a failed invoice is a write. It writes in three places: retrying an invoice that already failed, setting a customer default payment method after a card update, and submitting dispute evidence you approved. It never changes your prices, products, or subscription plans, and never reaches your payouts.",
      },
      {
        title: "AES-256-GCM token encryption",
        tag: "platform",
        body: "Stripe access tokens are encrypted at rest with Web Crypto, decrypted only in memory during execution.",
      },
      {
        title: "Stripe webhook verification",
        tag: "platform",
        body: "Every webhook is verified with constructEvent signature checking, with a Durable-Object-serialized claim so an event can't double-process.",
      },
      {
        title: "Enforced security headers and CSP",
        tag: "platform",
        body: "Response headers and a content-security policy are enforced on every request.",
      },
      {
        title: "Role-gated admin",
        tag: "platform",
        body: "A real middleware guard, not a UI-only check, controls whether /admin is reachable at all.",
      },
      {
        title: "CAN-SPAM compliance",
        tag: "platform",
        body: "Signed unsubscribe tokens, a suppression list, and one-click unsubscribe on every commercial email.",
      },
      {
        title: "WCAG 2.2 AA target",
        tag: "platform",
        body: "Reduced-motion, increased-contrast, and forced-colors modes are implemented, not just targeted.",
      },
    ],
  },
];

export function meta({ loaderData }: Route.MetaArgs) {
  return marketingMeta({
    title: "Features - Foxhound",
    description:
      "Everything Foxhound does, organized by capability and tagged by product: Audit, Recovery, Disputes, and Intelligence.",
    path: "/features",
    siteUrl: loaderData?.siteUrl ?? "",
  });
}

export function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  return { siteUrl: siteUrl(env) };
}

export default function FeaturesPage({ loaderData }: Route.ComponentProps) {
  const { siteUrl: url } = loaderData;
  const [filter, setFilter] = useState<FilterValue>("All");

  return (
    <div>
      <style>{FILTER_CSS}</style>
      <MarketingPageHeader
        eyebrow="Platform"
        title="Features"
        subtext="Everything Foxhound does. Organized by capability, tagged by product."
      />

      <div className="mx-auto max-w-[1100px] px-5 pb-16 sm:px-8">
        <div data-feature-filter={filter}>
          <div role="tablist" aria-label="Filter features by product" className="mb-10 flex flex-wrap gap-2">
            {FILTERS.map((f) => (
              <button
                key={f}
                type="button"
                role="tab"
                aria-selected={filter === f}
                onClick={() => setFilter(f)}
                className={`rounded-full border px-3 py-1.5 font-mono text-caption font-medium transition-colors ${
                  filter === f
                    ? "border-brand bg-brand text-on-brand"
                    : "border-border bg-surface text-text-secondary hover:border-brand-text hover:text-text"
                }`}
              >
                {f}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-1 gap-12 lg:grid-cols-[220px_1fr]">
            <aside className="hidden lg:block">
              <nav aria-label="Sections" className="sticky top-20 space-y-1">
                {CATEGORIES.map((category) => (
                  <a
                    key={category.heading}
                    href={`#${sectionId(category.heading)}`}
                    className="block border-l border-border py-1 pl-3 text-label text-text-secondary transition-colors hover:border-brand-text hover:text-text"
                  >
                    {category.heading}
                  </a>
                ))}
              </nav>
            </aside>

            {/* Legacy wraps this column in <main>; Foxhound renders one main
                landmark per document from the layout (ratified), so this is a
                plain div. */}
            <div className="space-y-16">
              {CATEGORIES.map((category) => (
                <section key={category.heading} id={sectionId(category.heading)} className="scroll-mt-20">
                  <div className="mb-6">
                    <h2 className="mb-1 text-title font-medium text-text">{category.heading}</h2>
                  </div>
                  <SectionInlineExample id={sectionId(category.heading)} />
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {category.features.map((feature) => (
                      <div
                        key={feature.title}
                        data-product={TAG_LABEL[feature.tag]}
                        className="rounded-lg border border-border bg-surface p-4"
                      >
                        <div className="mb-2 flex items-start justify-between gap-3">
                          <span className="text-copy font-medium text-text">{feature.title}</span>
                          <ProductTag tag={feature.tag} />
                        </div>
                        <p className="m-0 text-label leading-relaxed text-text-secondary">{feature.body}</p>
                      </div>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-24 border-t border-border pt-12 text-center">
          <p className="mx-auto mb-6 max-w-[400px] text-item-title text-text-secondary">
            See what your Stripe account is leaking. Free diagnostic, no account required.
          </p>
          <Link
            to="/audit"
            className="btn-primary inline-flex items-center gap-2 rounded-lg px-6 py-3 text-item-title font-medium text-on-brand"
          >
            Run your free audit
          </Link>
        </div>
      </div>

      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(
            breadcrumbListJsonLd(url, [
              { name: "Home", path: "/" },
              { name: "Features", path: "/features" },
            ]),
          ),
        }}
      />
    </div>
  );
}
