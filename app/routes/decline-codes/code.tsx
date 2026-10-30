import { ArrowLeft } from "lucide-react";
import { Link } from "react-router";

import { Badge } from "~/components/badge";
import { FaqAccordion } from "~/components/faq-accordion";
import { MarketingPageHeader } from "~/components/marketing-page-header";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { getDeclineCodeView } from "~/lib/decline-codes/codes";
import { DECLINE_CONTENT } from "~/lib/decline-codes/content";
import { CATEGORY_STATUS_LABEL, categoryBadgeTone, recoveryApproach } from "~/lib/decline-codes/presentation";
import { breadcrumbListJsonLd, faqPageJsonLd, siteUrl } from "~/lib/seo/jsonld";
import { marketingMeta } from "~/lib/seo/meta";

import type { Route } from "./+types/code";
import { jsonLd } from "@drdustinedwards/site-helpers/schema";

// NEW in Phase 6 Pass 3. Templated page for a single Stripe decline code.
// Category, retryability, and whether the code rides classifyDecline()'s
// safe default are ALWAYS read live from app/lib/decline-codes/codes.ts,
// which calls the real recovery-engine functions; nothing here re-derives
// or hand-assigns a category. Structure per TASK-foxhound-phase6.md: What it
// means / Why it happens / How to fix / How Foxhound recovers it / FAQ.
export function loader({ params, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const view = getDeclineCodeView(params.code);
  if (!view) {
    throw new Response("Not found", { status: 404 });
  }
  const content = DECLINE_CONTENT[view.code];
  return { siteUrl: siteUrl(env), view, content };
}

export function meta({ loaderData }: Route.MetaArgs) {
  if (!loaderData) return [{ title: "Decline code - Foxhound" }];
  const { view, siteUrl: url } = loaderData;
  return [
    ...marketingMeta({
      title: `${view.displayName} (${view.code}) decline code`,
      suffix: " - Foxhound",
      description: `What the Stripe ${view.code} decline code means, why it happens, how to fix it, and how Foxhound recovers it.`,
      path: `/decline-codes/${view.code}`,
      siteUrl: url,
    }),
    jsonLd(breadcrumbListJsonLd(url, [
      { name: "Home", path: "/" },
      { name: "Decline codes", path: "/decline-codes" },
      { name: view.displayName, path: `/decline-codes/${view.code}` },
    ])),
    jsonLd(faqPageJsonLd(loaderData.content.faqs.map((f) => ({ question: f.question, answer: f.answer })))),
  ];
}

export default function DeclineCodePage({ loaderData }: Route.ComponentProps) {
  const { view, content } = loaderData;

  return (
    <div>
      <MarketingPageHeader
        eyebrow="Decline code"
        title={view.displayName}
        subtext={content.meaning}
      />

      <div className="mx-auto max-w-3xl px-4 pb-16 sm:px-8">
        <Link
          to="/decline-codes"
          className="group mb-8 inline-flex items-center gap-1.5 text-label text-text-tertiary hover:text-text"
        >
          <ArrowLeft className="transition-transform group-hover:-translate-x-0.5" size={13} strokeWidth={1.5} aria-hidden />
          Back to decline codes
        </Link>

        <div className="mb-8 flex flex-wrap items-center gap-2">
          <span className="rounded-lg border border-border bg-surface px-3 py-1.5 font-mono text-micro text-text-tertiary">
            {view.code}
          </span>
          <Badge tone={categoryBadgeTone(view.category)}>{CATEGORY_STATUS_LABEL[view.category]}</Badge>
        </div>

        {/* Pass 3 content-doc check (session start and pre-write) found neither
            phase6-content-decline-codes.md content, so this page's prose is
            template copy, not a dedicated content pass's final wording. Marked
            visibly rather than silently, per the task's instruction to leave
            placeholder content clearly marked. */}
        <div className="mb-8 rounded-lg border border-border-sub bg-surface2 px-4 py-3 text-label text-text-tertiary">
          Draft content: this page's explanatory copy is Pass 3 template writing pending a
          dedicated content pass. The classification badge above and the recovery behavior
          described below are live, not draft: both come directly from the recovery engine.
        </div>

        <section className="mb-10">
          <h2 className="mb-3 text-title font-medium text-text">Why it happens</h2>
          <p className="text-body leading-relaxed text-text-secondary">{content.whyItHappens}</p>
        </section>

        <section className="mb-10">
          <h2 className="mb-3 text-title font-medium text-text">How to fix it</h2>
          <p className="text-body leading-relaxed text-text-secondary">{content.howToFix}</p>
        </section>

        <section className="mb-10 rounded-lg border border-border bg-surface p-5">
          <h2 className="mb-3 text-title font-medium text-text">How Foxhound recovers it</h2>
          <p className="text-body leading-relaxed text-text-secondary">{recoveryApproach(view)}</p>
        </section>

        <section className="mb-10">
          <h2 className="mb-4 text-title font-medium text-text">Questions</h2>
          <FaqAccordion faqs={content.faqs.map((f) => ({ question: f.question, answer: f.answer }))} />
        </section>

        <div className="rounded-lg border border-border bg-surface p-6 text-center">
          <p className="mb-2 text-body font-medium text-text">See what this looks like on your account</p>
          <p className="mb-5 text-label text-text-secondary">
            The free audit shows what Stripe already recovered and what is still dying, no signup required.
          </p>
          <Link
            to="/audit"
            className="inline-flex items-center gap-2 rounded-md bg-brand px-5 py-2.5 text-label font-medium text-on-brand hover:bg-brand-dark"
          >
            Run your free audit
          </Link>
        </div>
      </div>
    </div>
  );
}
