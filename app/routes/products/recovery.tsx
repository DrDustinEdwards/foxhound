import { RefreshCw } from "lucide-react";

import { Badge } from "~/components/badge";
import {
  BottomCTA,
  FeatureBlocks,
  HowItWorks,
  ProductFAQ,
  ProductHero,
  ProductPricing,
} from "~/components/product-sections";

// Ported from legacy app/(marketing)/product/recovery/page.tsx (Phase 6
// Pass 1). Copy corrections #1 and #4: silent-first is the lead ("smarter
// than Smart Retries" becomes "quiet before loud"), baseline-free and
// 30-day maturity framing throughout.

export function meta() {
  return [
    { title: "Recovery - Foxhound" },
    {
      name: "description",
      content:
        "Silent retries first, then AI-drafted email sequences across 30 days. 20% of what Foxhound recovers, nothing Stripe would have gotten anyway.",
    },
  ];
}

const STEPS = [
  {
    title: "Payment fails on Stripe",
    body: "Foxhound receives the webhook within seconds. The decline code is classified: soft, network, expired, or fraud.",
  },
  {
    title: "Foxhound tries quietly first",
    body: "A silent retry runs before any customer ever sees an email. Only if that does not work does an AI-drafted email sequence begin, timed across 30 days. Fraud declines are never retried.",
  },
  {
    title: "You pay 20% of matured recoveries",
    body: "Each monthly run bills the prior month's recoveries that have matured for 30+ days, at 20%. Nothing is billed for recoveries Stripe's own retries would have gotten anyway.",
  },
];

const FAQS = [
  {
    q: "What counts as a recovered payment Foxhound can bill for?",
    a: "Only recoveries where a Foxhound action provably preceded payment: a scheduled retry succeeded, a dunning email was clicked or otherwise engaged, or a card was updated through a Foxhound page. Payments Stripe's own Smart Retries recover independently are recorded as free.",
  },
  {
    q: "What happens if a customer replies to a recovery email?",
    a: "Replies go to the notification email set in your Foxhound settings. Foxhound sends with your brand name, so replies come back to you.",
  },
  {
    q: "Can I pause or cancel a sequence?",
    a: "Yes. From the payment detail page you can pause, resume, or cancel any active sequence, or trigger an immediate retry at any time.",
  },
];

// Grounded in the real app/routes/app/recovery/payments/detail.tsx "Recovery
// timeline" section: a numbered step, its type (formatStepType vocabulary),
// its channel (Silent for retries, Customer email/Customer action otherwise),
// and a result Badge, "Pending" when the step hasn't run yet (Phase 6 Pass 1
// review fix: replaces an invented step list with the real timeline shape).
function RecoveryTimelinePreview() {
  const STEPS = [
    { step: 1, type: "Silent retry", channel: "Silent", result: "Retry succeeded", tone: "success" as const },
    { step: 2, type: "Email 1", channel: "Customer email", result: "Email sent", tone: "success" as const },
    { step: 3, type: "Retry (day 7)", channel: "Silent", result: null, tone: "neutral" as const },
    { step: 4, type: "Email (day 14)", channel: "Customer email", result: null, tone: "neutral" as const },
  ];
  return (
    <div className="flex flex-col gap-2.5 p-5">
      <p className="mb-0.5 font-mono text-micro text-text-subtle">Sample account, recovery timeline</p>
      {STEPS.map((s) => (
        <div
          key={s.step}
          className="flex items-center justify-between gap-3 rounded-lg border border-border-sub bg-surface px-4 py-2.5"
        >
          <p className="text-label text-text">
            {s.step}. {s.type}
            <span className="ml-2 text-micro uppercase tracking-wide text-text-subtle">{s.channel}</span>
          </p>
          <Badge tone={s.tone}>{s.result ?? "Pending"}</Badge>
        </div>
      ))}
    </div>
  );
}

// Grounded in the payment detail page's "Outcome" section: a neutral-tone
// decline-category badge next to a neutral-tone attribution badge, with the
// real "- FREE" suffix the app appends only to stripe_baseline attributions
// (app/lib/recovery/labels.ts ATTRIBUTION_KIND_LABELS + detail.tsx's inline
// suffix). Category and attribution wording matches DECLINE_CATEGORY_LABELS
// and ATTRIBUTION_KIND_LABELS exactly.
function AttributionOutcomePreview() {
  const ROWS = [
    { decline: "Soft decline", attribution: "Foxhound retry", free: false },
    { decline: "Network error", attribution: "Email engaged", free: false },
    { decline: "Expired card", attribution: "Card update", free: false },
    { decline: "Suspected fraud", attribution: "Stripe baseline", free: true },
  ];
  return (
    <div className="flex flex-col gap-2 p-5">
      <p className="mb-1 font-mono text-micro text-text-subtle">Sample account, outcome by decline category</p>
      {ROWS.map((r) => (
        <div
          key={r.decline}
          className="flex items-center justify-between gap-3 border-b border-border-sub pb-2 last:border-0 last:pb-0"
        >
          <Badge tone="neutral">{r.decline}</Badge>
          <Badge tone="neutral">
            {r.attribution}
            {r.free ? " - FREE" : ""}
          </Badge>
        </div>
      ))}
    </div>
  );
}

const BLOCKS = [
  {
    eyebrow: "Quiet before loud",
    title: "A silent retry runs before any email does.",
    body: "Stripe's Smart Retries treat every decline the same. Foxhound classifies the decline first, then tries a quiet retry before a customer ever sees a dunning email, so nobody gets bothered for a payment that would have recovered on its own.",
    ui: <RecoveryTimelinePreview />,
  },
  {
    eyebrow: "Four categories, four sequences",
    title: "Fraud declines are never retried.",
    body: "Soft and network declines get a silent retry first. Expired cards skip straight to a sequence, a retry cannot fix an expired card. Fraud declines get a single email and no retry at all.",
    ui: <AttributionOutcomePreview />,
  },
];

export default function RecoveryProductPage() {
  return (
    <>
      <ProductHero
        productName="Recovery"
        Icon={RefreshCw}
        headline={
          <>
            <span className="font-mono">20%</span> of what Foxhound recovers.
            <br />
            Nothing Stripe would have gotten anyway.
          </>
        }
        sub="Silent retries first, then AI-drafted email sequences across 30 days. Four decline categories, four different sequences. Nothing is billed until the recovery has matured for 30 days."
        pricing="20% of Foxhound-attributed recoveries · No monthly fee · Baseline recoveries are free"
        primaryCTA={{ href: "/audit", label: "Run your free audit" }}
        secondaryCTA={{ href: "/docs/recovery", label: "Read the guide" }}
      />
      <HowItWorks steps={STEPS} />
      <FeatureBlocks sectionLabel="How the sequence decides" blocks={BLOCKS} />
      <ProductPricing
        price="20%"
        priceLabel="of Foxhound-attributed recoveries, billed monthly on matured recoveries"
        points={[
          "No monthly fee, nothing owed until Foxhound recovers a payment",
          "Baseline recoveries Stripe would have gotten anyway are free",
          "Nothing billed until the recovery has matured for 30 days",
          "30-day sequences across 4 decline categories",
          "Silent retry before any customer-facing email",
          "Card-update link on every email",
          "Open and click tracking per email step",
          "Unlimited Stripe accounts at the same per-account rate",
        ]}
        ctaHref="/audit"
        ctaLabel="Run your free audit"
      />
      <ProductFAQ faqs={FAQS} />
      <BottomCTA
        title="See what is currently unrecovered."
        sub="The free audit shows your failed invoices today, before you connect anything else."
        ctaHref="/audit"
        ctaLabel="Run your free audit"
        note="No account required · Read-only Stripe access · Takes 30 seconds"
      />
    </>
  );
}
