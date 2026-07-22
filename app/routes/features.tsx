import { useState } from "react";

import { Badge } from "~/components/badge";
import { BottomCTA } from "~/components/product-sections";
import { MarketingPageHeader } from "~/components/marketing-page-header";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { breadcrumbListJsonLd, siteUrl } from "~/lib/seo/jsonld";

import type { Route } from "./+types/features";

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

const FILTERS: { key: "all" | Tag; label: string }[] = [
  { key: "all", label: "All" },
  { key: "platform", label: "Platform" },
  { key: "audit", label: "Audit" },
  { key: "recovery", label: "Recovery" },
  { key: "disputes", label: "Disputes" },
  { key: "intelligence", label: "Intelligence" },
];

interface Feature {
  title: string;
  tag: Tag;
  body: string;
}

interface Category {
  heading: string;
  features: Feature[];
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
        title: "Four decline categories, four sequences",
        tag: "recovery",
        body: "Every Stripe decline code maps to soft, network, expired, or fraud. Timing and retry strategy differ by category.",
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
        body: "Read-only connection, connects in under a minute, never touches your billing configuration.",
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
        title: "Read-only Stripe scope",
        tag: "platform",
        body: "Foxhound requests read-only Stripe Connect access. It reads your data and never modifies your Stripe configuration.",
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
  const url = loaderData?.siteUrl ?? "";
  return [
    { title: "Features - Foxhound" },
    {
      name: "description",
      content:
        "Everything Foxhound does, organized by capability and tagged by product: Audit, Recovery, Disputes, and Intelligence.",
    },
    { tagName: "link", rel: "canonical", href: `${url}/features` },
  ];
}

export function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  return { siteUrl: siteUrl(env) };
}

export default function FeaturesPage({ loaderData }: Route.ComponentProps) {
  const { siteUrl: url } = loaderData;
  const [filter, setFilter] = useState<"all" | Tag>("all");

  const visibleCategories = CATEGORIES.map((category) => ({
    ...category,
    features: category.features.filter((f) => filter === "all" || f.tag === filter),
  })).filter((category) => category.features.length > 0);

  return (
    <div>
      <MarketingPageHeader
        eyebrow="Platform"
        title="Features"
        subtext="Everything Foxhound does. Organized by capability, tagged by product."
      />

      <div className="mx-auto max-w-5xl px-4 pb-8 sm:px-8">
        <div className="flex flex-wrap gap-2 border-b border-border-sub pb-8">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              aria-pressed={filter === f.key}
              className={`rounded-full border px-3.5 py-1.5 text-label font-medium transition-colors duration-150 ${
                filter === f.key
                  ? "border-amber bg-amber text-on-amber"
                  : "border-border text-text-secondary hover:border-border-i hover:text-text"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="mx-auto max-w-5xl px-4 pb-16 sm:px-8">
        {visibleCategories.map((category) => (
          <section key={category.heading} className="border-b border-border-sub py-8 last:border-0">
            <h2 className="mb-4 text-title font-medium text-text">{category.heading}</h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {category.features.map((feature) => (
                <div key={feature.title} className="rounded-lg border border-border bg-surface p-4">
                  <div className="mb-2 flex items-start justify-between gap-2">
                    <p className="text-label font-medium text-text">{feature.title}</p>
                    <Badge tone="neutral">{TAG_LABEL[feature.tag]}</Badge>
                  </div>
                  <p className="text-label leading-relaxed text-text-secondary">{feature.body}</p>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>

      <BottomCTA
        title="See what your Stripe account is leaking."
        sub="Free diagnostic, no account required."
        ctaHref="/audit"
        ctaLabel="Run your free audit"
        note="No account required · Read-only Stripe access · Takes 30 seconds"
      />

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
