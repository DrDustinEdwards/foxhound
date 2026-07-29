import { Shield } from "lucide-react";

import { Badge } from "~/components/badge";
import {
  BottomCTA,
  FeatureBlocks,
  HowItWorks,
  ProductFAQ,
  ProductHero,
  ProductPricing,
} from "~/components/product-sections";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { siteUrl, speakableWebPageJsonLd } from "~/lib/seo/jsonld";
import { marketingMeta } from "~/lib/seo/meta";

import type { Route } from "./+types/disputes";

// Ported from legacy app/(marketing)/product/disputes/page.tsx (Phase 6
// Pass 1). Copy correction #3: the built product explicitly rejected
// auto-submit (schema-enforced human approval, never a toggle). Every
// "auto-submit before the deadline" claim from legacy is rewritten to
// review-and-sign.

export function meta({ loaderData }: Route.MetaArgs) {
  return marketingMeta({
    title: "Disputes - Foxhound",
    description:
      "Evidence drafted for every dispute. You review and sign every submission. 20% only when you win, capped at $500.",
    path: "/products/disputes",
    siteUrl: loaderData?.siteUrl ?? "",
  });
}

export function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  return { siteUrl: siteUrl(env) };
}

const STEPS = [
  {
    title: "Dispute opens on Stripe",
    body: "Foxhound receives the webhook within seconds and drafts evidence from prior charges, recovery emails, and Stripe signals.",
  },
  {
    title: "The draft waits for you",
    body: "Every draft moves through review before it can be approved. Nothing reaches Stripe without a person on your team signing off.",
  },
  {
    title: "You approve, then it submits",
    body: "Review the staged evidence, edit anything you want, and approve it. 20% only when the submission wins, capped at $500 per dispute.",
  },
];

const FAQS = [
  {
    q: "Does Foxhound ever submit a dispute automatically?",
    a: "No. There is no auto-submit toggle, and there never has been one. Every submission requires a human on your team to review and approve it first, enforced by the underlying workflow, not just a setting you could accidentally leave on.",
  },
  {
    q: "What if I want to edit the drafted evidence myself?",
    a: "You can edit any drafted evidence before approving it. Add context, attach files, or rewrite the structured evidence. Foxhound's draft is a starting point, not a constraint.",
  },
  {
    q: "What does Foxhound charge if a dispute is lost or accepted?",
    a: "Nothing. The 20% fee only applies to disputes Foxhound helps you win, and it is capped at $500 per dispute regardless of the amount in dispute.",
  },
];

// Grounded in the real app/routes/app/disputes/detail.tsx state machine and
// app/lib/disputes/labels.ts's disputeStateTone: draft, pending_review,
// approved, and submitted are all neutral-tone (a dispute mid-review is
// neither a success nor a failure), only the two resolved terminal states get
// a tone, resolved_won success and resolved_lost failure (Phase 6 Pass 1
// review fix: the prior version wrongly colored approved/submitted success).
// The fee/no-fee copy on the outcome cards matches detail.tsx's own
// "Won. Fee ... billed" / "Lost. Not billed." wording.
function DisputeStatePreview() {
  const STAGES = [
    { label: "Draft", tone: "neutral" as const, note: undefined },
    { label: "Pending review", tone: "neutral" as const, note: "Waits for a human" },
    { label: "Approved", tone: "neutral" as const, note: undefined },
    { label: "Submitted", tone: "neutral" as const, note: undefined },
  ];
  const OUTCOMES = [
    { label: "Won", tone: "success" as const, note: "Fee billed at the next monthly run" },
    { label: "Lost", tone: "failure" as const, note: "Not billed" },
  ];
  return (
    <div className="flex flex-col gap-3 p-5">
      <p className="font-mono text-micro text-text-subtle">Sample dispute, state by state</p>
      <div className="flex flex-col gap-2">
        {STAGES.map((s, i) => (
          <div key={s.label} className="flex items-center gap-3 rounded-lg border border-border-sub bg-surface px-4 py-2.5">
            <span className="font-mono text-micro text-text-subtle">{i + 1}</span>
            <Badge tone={s.tone}>{s.label}</Badge>
            {s.note ? <span className="text-micro text-text-tertiary">{s.note}</span> : null}
          </div>
        ))}
      </div>
      <div className="flex gap-3">
        {OUTCOMES.map((o) => (
          <div key={o.label} className="flex flex-1 flex-col gap-1 rounded-lg border border-border-sub bg-surface px-4 py-2.5">
            <Badge tone={o.tone}>{o.label}</Badge>
            <span className="text-micro text-text-tertiary">{o.note}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Grounded in the real detail.tsx "Evidence draft" card: an uppercase
// font-mono micro label above a read-only field value, styled in the same
// bordered/surface2 idiom as the actual <textarea> the merchant reviews.
function EvidenceDraftPreview() {
  const FIELDS = ["Customer name", "Product description", "Prior communication", "Refund policy"];
  return (
    <div className="flex flex-col gap-3 p-5">
      <p className="font-mono text-micro text-text-subtle">Sample dispute, evidence draft</p>
      {FIELDS.map((f) => (
        <div key={f} className="flex flex-col gap-1">
          <span className="font-mono text-micro uppercase tracking-wide text-text-tertiary">{f}</span>
          <div className="rounded-md border border-border bg-surface2 px-3 py-2 text-label text-text-tertiary">
            Drafted from prior charges and Stripe signals
          </div>
        </div>
      ))}
    </div>
  );
}

const BLOCKS = [
  {
    eyebrow: "The approval gate is the feature",
    title: "Nothing submits without a human sign-off.",
    body: "Every draft moves through pending_review before it can be approved, and every submission is a separate, explicit step. There is no auto-submit toggle because the system does not have one, it never did.",
    ui: <DisputeStatePreview />,
  },
  {
    eyebrow: "Built automatically",
    title: "Evidence drafted before you open the dispute.",
    body: "Prior charge history, recovery email history, AVS and CVV results, and Stripe's own signals are pulled together into a draft the moment a dispute opens, so review is fast even though submission is not automatic.",
    ui: <EvidenceDraftPreview />,
  },
];

export default function DisputesProductPage({ loaderData }: Route.ComponentProps) {
  const { siteUrl: url } = loaderData;

  return (
    <>
      <ProductHero
        productName="Disputes"
        Icon={Shield}
        headline={"Evidence drafted for you.\nYou review and sign every submission."}
        sub="When a dispute opens, Foxhound drafts evidence from your recovery history, Stripe signals, and transaction data. A human on your team reviews and approves it before anything reaches Stripe."
        pricing="20% of won disputes, capped at $500 · Nothing on losses or accepted disputes"
        primaryCTA={{ href: "/connect", label: "Connect Stripe" }}
        secondaryCTA={{ href: "/docs/disputes", label: "Read the guide" }}
      />
      <HowItWorks steps={STEPS} />
      <FeatureBlocks sectionLabel="What you see after connecting" blocks={BLOCKS} />
      <ProductPricing
        price="20%"
        priceLabel="of disputes Foxhound wins, capped at $500 per dispute"
        points={[
          "Nothing on disputes you lose or accept",
          "Evidence drafted automatically from prior charges and Stripe signals",
          "Draft, pending_review, approved, submitted, resolved, every dispute",
          "No auto-submit toggle exists",
          "Outcome feeds back into Intelligence customer scoring",
        ]}
        ctaHref="/connect"
        ctaLabel="Connect Stripe"
      />
      <ProductFAQ faqs={FAQS} />
      <BottomCTA
        title="Stop losing disputes to missed deadlines, not to a machine you don't trust."
        sub="Connect Stripe and Foxhound starts drafting evidence on every new dispute automatically. You still approve every submission."
        ctaHref="/connect"
        ctaLabel="Connect Stripe"
        note="Evidence reaches Stripe only after you approve it · 20% only when you win, capped at $500"
      />
      {/* SpeakableSpecification. The selectors point at classes injected by
          product-sections.tsx. Legacy carries this on every spoke. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(
            speakableWebPageJsonLd(url, {
              name: "Disputes - Foxhound",
              path: "/products/disputes",
              selectors: [".speakable-hero", ".speakable-description", ".speakable-features"],
            }),
          ),
        }}
      />
    </>
  );
}
