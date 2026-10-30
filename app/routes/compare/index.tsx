import { ArrowRight } from "lucide-react";
import { Link } from "capsomer/react/link";

import { MarketingPageHeader } from "~/components/marketing-page-header";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { COMPETITOR_ORDER, COMPETITORS } from "~/lib/compare/competitors";
import { breadcrumbListJsonLd, siteUrl } from "~/lib/seo/jsonld";
import { marketingMeta } from "~/lib/seo/meta";

import type { Route } from "./+types/index";

// NEW in Phase 6 Pass 3 (net-new). /compare hub: a card grid linking to each
// of the six named competitor pages (ROUTES.md Rev 2). Honest by
// construction: card copy is each competitor's one-liner from the shared
// data module, not marketing spin written separately here.

export function meta({ loaderData }: Route.MetaArgs) {
  return marketingMeta({
    title: "Compare Foxhound - Foxhound",
    description:
      "How Foxhound compares to Stripe Smart Retries, Churnkey, Churn Buster, Paddle Retain, Baremetrics Recover and Stunning, with honest pros and cons.",
    path: "/compare",
    siteUrl: loaderData?.siteUrl ?? "",
  });
}

export function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  return { siteUrl: siteUrl(env) };
}

export default function CompareIndex({ loaderData }: Route.ComponentProps) {
  const { siteUrl: url } = loaderData;

  return (
    <div>
      <MarketingPageHeader
        eyebrow="Compare"
        title="How Foxhound compares"
        subtext="Honest tables, including where Foxhound is newer or narrower than the incumbents. No fabricated competitor numbers."
      />

      <div className="mx-auto max-w-5xl px-4 pb-16 sm:px-8">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {COMPETITOR_ORDER.map((slug) => {
            const c = COMPETITORS[slug];
            return (
              <Link
                key={slug}
                to={`/compare/${slug}`}
                className="group block rounded-lg border border-border bg-surface p-5 hover:border-border-i"
              >
                <p className="mb-1 font-mono text-micro uppercase tracking-wide text-text-tertiary">{c.category}</p>
                <p className="mb-2 text-body font-medium text-text">Foxhound vs {c.name}</p>
                <p className="mb-4 text-label leading-relaxed text-text-secondary">{c.oneLiner}</p>
                <div className="text-label text-brand-text">
                  See the comparison{" "}
                  <ArrowRight
                    className="inline-block transition-transform duration-150 group-hover:translate-x-0.5"
                    size={13}
                    strokeWidth={1.5}
                    aria-hidden
                  />
                </div>
              </Link>
            );
          })}
        </div>
      </div>

      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(
            breadcrumbListJsonLd(url, [
              { name: "Home", path: "/" },
              { name: "Compare", path: "/compare" },
            ]),
          ),
        }}
      />
    </div>
  );
}
