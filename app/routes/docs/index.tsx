import { ArrowRight } from "lucide-react";
import { Link } from "react-router";

import { MarketingPageHeader } from "~/components/marketing-page-header";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { DOC_GUIDES } from "~/lib/marketing/docs-content";
import { breadcrumbListJsonLd, docsItemListJsonLd, siteUrl } from "~/lib/seo/jsonld";
import { marketingMeta } from "~/lib/seo/meta";

import type { Route } from "./+types/index";

// Ported from legacy app/(marketing)/docs/page.tsx (Phase 6 Pass 1). Platform
// renders as a full-width card above the product guide grid, same as
// legacy. Content itself is a deliberately modest, hand-written set (see
// app/lib/marketing/docs-content.ts), not the full 5-guide legacy library.

export function meta({ loaderData }: Route.MetaArgs) {
  return marketingMeta({
    title: "Docs - Foxhound",
    description: "User guides for Foxhound: platform setup, recovery, disputes, and intelligence.",
    path: "/docs",
    siteUrl: loaderData?.siteUrl ?? "",
  });
}

export function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  return { siteUrl: siteUrl(env) };
}

export default function DocsIndexPage({ loaderData }: Route.ComponentProps) {
  const url = loaderData.siteUrl;
  const platform = DOC_GUIDES.find((g) => g.slug === "platform")!;
  const productGuides = DOC_GUIDES.filter((g) => g.slug !== "platform");

  return (
    <>
      <MarketingPageHeader eyebrow="User guides" title="Documentation" subtext="Documentation for the Foxhound platform." />

      {/* div, not main: marketing.tsx already renders this page's one main landmark. */}
      <div className="mx-auto max-w-[720px] px-6 pb-16">
        <div className="flex flex-col gap-4">
          <Link
            to={`/docs/${platform.slug}`}
            className="group block rounded-lg border border-border bg-surface p-5 transition-colors hover:border-brand"
          >
            <div className="mb-2 text-item-title font-medium text-text">{platform.title}</div>
            <div className="mb-4 text-label leading-relaxed text-text-secondary">{platform.description}</div>
            <div className="text-label text-brand-text">
              Read guide{" "}
              <ArrowRight
                className="inline-block transition-transform duration-150 group-hover:translate-x-0.5"
                size={13}
                strokeWidth={1.5}
                aria-hidden
              />
            </div>
          </Link>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {productGuides.map((g) => (
              <Link
                key={g.slug}
                to={`/docs/${g.slug}`}
                className="group block rounded-lg border border-border bg-surface p-5 transition-colors hover:border-brand"
              >
                <div className="mb-2 text-item-title font-medium text-text">{g.title}</div>
                <div className="mb-4 text-label leading-relaxed text-text-secondary">{g.description}</div>
                <div className="text-label text-brand-text">
                  Read guide{" "}
                  <ArrowRight
                    className="inline-block transition-transform duration-150 group-hover:translate-x-0.5"
                    size={13}
                    strokeWidth={1.5}
                    aria-hidden
                  />
                </div>
              </Link>
            ))}
          </div>
        </div>

        <div className="mt-12 flex flex-wrap items-center gap-6 text-label">
          <Link
            to="/features"
            className="group text-brand-text transition-opacity duration-150 hover:opacity-80"
          >
            See all features{" "}
            <ArrowRight
              className="inline-block transition-transform duration-150 group-hover:translate-x-0.5"
              size={13}
              strokeWidth={1.5}
              aria-hidden
            />
          </Link>
          <Link
            to="/pricing"
            className="group text-brand-text transition-opacity duration-150 hover:opacity-80"
          >
            View pricing{" "}
            <ArrowRight
              className="inline-block transition-transform duration-150 group-hover:translate-x-0.5"
              size={13}
              strokeWidth={1.5}
              aria-hidden
            />
          </Link>
        </div>
      </div>

      {/* The hub as a LIST, so a crawler reading /docs gets the set rather than
          five pages it has to discover by link-following. Derived from
          DOC_GUIDES in render order, so a sixth guide joins it by construction. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify([
            docsItemListJsonLd(url, DOC_GUIDES),
            breadcrumbListJsonLd(url, [{ name: "Docs", path: "/docs" }]),
          ]),
        }}
      />
    </>
  );
}
