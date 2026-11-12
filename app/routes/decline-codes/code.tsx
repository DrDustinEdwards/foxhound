import { Pill } from "capsomer/react/status";
import "capsomer/status.css";
import { Link } from "capsomer/react/link";

import { BADGE_PILL } from "~/lib/recovery/labels";
import { FaqAccordion } from "~/components/faq-accordion";
import { MarketingPageHeader } from "~/components/marketing-page-header";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import { getDeclineCodeView } from "~/lib/decline-codes/codes";
import { DECLINE_CONTENT } from "~/lib/decline-codes/content";
import {
  CATEGORY_STATUS_LABEL,
  categoryBadgeTone,
  recoveryApproach,
} from "~/lib/decline-codes/presentation";
import { faqPage } from "@drdustinedwards/site-helpers/schema";
import { siteUrl } from "~/lib/seo/jsonld";
import { marketingMeta } from "~/lib/seo/meta";

import type { Route } from "./+types/code";
import { jsonLd } from "@drdustinedwards/site-helpers/schema";
import "capsomer/button.css";

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
      description: `What the Stripe ${view.code} decline code means, why it happens, how to fix it, and how Foxhound recovers it.`,
      path: `/decline-codes/${view.code}`,
      siteUrl: url,
    }),
    jsonLd(
      faqPage(loaderData.content.faqs.map((f) => ({ question: f.question, answer: f.answer }))),
    ),
  ];
}

export default function DeclineCodePage({ loaderData }: Route.ComponentProps) {
  const { view, content } = loaderData;

  return (
    <div>
      <MarketingPageHeader
        trail={[{ label: "Decline codes", href: "/decline-codes" }, { label: view.displayName }]}
        eyebrow="Decline code"
        title={view.displayName}
        subtext={content.meaning}
      />

      <div className="mx-auto max-w-3xl px-4 pb-16 sm:px-8">
        <div className="mb-8 flex flex-wrap items-center gap-2">
          <span className="rounded-lg border border-border bg-surface px-3 py-1.5 font-mono text-micro text-text-tertiary">
            {view.code}
          </span>
          <Pill {...BADGE_PILL[categoryBadgeTone(view.category)]}>
            {CATEGORY_STATUS_LABEL[view.category]}
          </Pill>
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
          <FaqAccordion
            faqs={content.faqs.map((f) => ({ question: f.question, answer: f.answer }))}
          />
        </section>

        <div
          className="fh-cap rounded-lg border border-border bg-surface p-6 text-center"
          data-cap-site="foxhound"
          data-family="amber"
        >
          <p className="mb-2 text-body font-medium text-text">
            See what this looks like on your account
          </p>
          <p className="mb-5 text-label text-text-secondary">
            The free audit shows what Stripe already recovered and what is still dying, no signup
            required.
          </p>
          <Link to="/audit" className="cap-btn" data-variant="primary">
            Run your free audit
          </Link>
        </div>
      </div>
    </div>
  );
}
