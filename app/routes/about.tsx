import { MarketingPageHeader } from "~/components/marketing-page-header";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { organizationJsonLd, personJsonLd, siteUrl, SUPPORT_EMAIL } from "~/lib/seo/jsonld";

import type { Route } from "./+types/about";

// NEW in Phase 6 Pass 1 (no legacy equivalent, per TASK-foxhound-phase6.md).
// Founder/company bio plus Person JSON-LD for E-E-A-T. Linked from the
// footer (required) and the header nav.

export function meta() {
  return [
    { title: "About - Foxhound" },
    {
      name: "description",
      content: "Foxhound is built and run by Dustin Edwards, a US company built on Stripe Connect.",
    },
  ];
}

export function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  return { siteUrl: siteUrl(env) };
}

export default function AboutPage({ loaderData }: Route.ComponentProps) {
  return (
    <div>
      <MarketingPageHeader
        eyebrow="About"
        title="Built by one person, held to Stripe's own numbers"
        subtext="Foxhound is a small, US company built on Stripe Connect."
      />

      <main className="mx-auto max-w-2xl px-4 pb-20 sm:px-8">
        <div className="flex flex-col gap-6 text-body leading-relaxed text-text-secondary">
          <p>
            Foxhound is built and run by Dustin Edwards. It started as a rebuild of an earlier payment
            recovery product, this time built around a stricter promise: Foxhound only earns money when
            it creates money the merchant can verify they would not otherwise have.
          </p>
          <p>
            That promise shows up in the product, not just the pricing page. Every billed dollar links
            back to the evidence that earned it, a retry that succeeded, an email that was actually
            clicked, a card that was actually updated. Recoveries Stripe&apos;s own tools would have
            gotten anyway are recorded and shown for free. Dispute evidence is drafted automatically, but
            nothing reaches Stripe without a human reviewing and signing off first, there is no
            auto-submit toggle to accidentally leave on.
          </p>
          <p>
            The company is US-based and operates under US jurisdiction. Foxhound is built on Stripe
            Connect, runs on Cloudflare Workers, and does not store card numbers.
          </p>
          <p>
            Questions, bug reports, or just curious how something works: reach out at{" "}
            <a href={`mailto:${SUPPORT_EMAIL}`} className="text-amber-text underline underline-offset-2 hover:opacity-80">
              {SUPPORT_EMAIL}
            </a>
            .
          </p>
        </div>
      </main>

      {/* personJsonLd's worksFor references the Organization node by @id
          (jsonld.ts); that node must actually be emitted on this page or
          the reference dangles. Render both here, same pattern as
          blog/post.tsx. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationJsonLd(loaderData.siteUrl)) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(
            personJsonLd(loaderData.siteUrl, {
              name: "Dustin Edwards",
              jobTitle: "Founder",
              description: "Founder of Foxhound, a pay-on-lift Stripe recovery, disputes, and intelligence platform.",
            }),
          ),
        }}
      />
    </div>
  );
}
