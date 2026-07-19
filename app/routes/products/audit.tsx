import { ScanSearch } from "lucide-react";

import {
  BottomCTA,
  FeatureBlocks,
  HowItWorks,
  ProductFAQ,
  ProductHero,
  ProductPricing,
} from "~/components/product-sections";

// Ported from legacy app/(marketing)/product/audit/page.tsx (Phase 6 Pass
// 1). Copy correction: no fabricated recovery-rate stat (legacy claimed a
// "32.26% across all time" platform average that does not exist yet for
// Foxhound). Framed around lift instead: what Stripe already recovered,
// what is still dying, what Foxhound would add.

export function meta() {
  return [
    { title: "Audit - Foxhound" },
    {
      name: "description",
      content:
        "Free Stripe diagnostic. See failed invoices, expiring cards, open disputes, and business health in 30 seconds. No account required.",
    },
  ];
}

const STEPS = [
  {
    title: "Connect Stripe",
    body: "Read-only OAuth connection. Foxhound never touches your billing configuration. Takes 30 seconds.",
  },
  {
    title: "Foxhound runs the diagnostic",
    body: "Four scopes pull the trailing period of data: failed invoices, expiring cards, open disputes, and business health.",
  },
  {
    title: "See your results",
    body: "Results are immediate and framed around lift: what Stripe already recovered, what is still dying, what Foxhound would add.",
  },
];

const FAQS = [
  {
    q: "Does the audit require a Foxhound account?",
    a: "No. Connect your Stripe account and results appear immediately. No email, no signup, no credit card. Create a free account afterward if you want to save results.",
  },
  {
    q: "What Stripe access does the audit request?",
    a: "Read-only OAuth scope. The audit reads your invoices, subscriptions, disputes, and customer data. It never modifies payment methods, subscription logic, or any other Stripe setting. Disconnect from your Stripe dashboard at any time.",
  },
  {
    q: "Will the audit tell me a recovery rate I should expect?",
    a: "No. There is no long-running platform history to project one from yet. The audit reports what your account actually shows: what Stripe already recovered, and what is still unrecovered.",
  },
];

// Both preview widgets below show illustrative sample data, explicitly
// labeled as such, not a platform-wide statistic (copy correction: no
// fabricated recovery-rate numbers).
function AuditScopePreview() {
  const SCOPES = [
    { label: "Failed invoices", value: "6 open" },
    { label: "Expiring cards", value: "3 within 30 days" },
    { label: "Open disputes", value: "0" },
    { label: "Business health", value: "MRR, churn" },
  ];
  return (
    <div className="p-5">
      <p className="mb-3 font-mono text-micro text-text-subtle">Sample account</p>
      <div className="grid grid-cols-2 gap-3">
        {SCOPES.map((s) => (
          <div key={s.label} className="rounded-lg border border-border-sub bg-surface px-4 py-3">
            <div className="font-mono text-micro uppercase tracking-wide text-text-tertiary">{s.label}</div>
            <div className="mt-1 font-mono text-body text-text">{s.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// No authenticated /app/audit surface exists yet to mirror (a Phase 8
// dependency); this instead builds a static mock of DESIGN.md's already-
// canon flagship-surface spec for this page: one headline number (lift),
// three bands beneath it (Stripe recovered / still dying / Foxhound adds),
// detail collapsed below.
function LiftPreview() {
  return (
    <div className="p-5">
      <p className="mb-3 font-mono text-micro text-text-subtle">Sample account, lift summary</p>
      <p className="font-mono text-display font-semibold text-text">+$4,820</p>
      <p className="mb-4 text-micro text-text-tertiary">Estimated lift if Foxhound had been running</p>
      <div className="flex flex-col gap-3">
        {[
          { label: "Stripe recovered", value: "$2,940", tone: "text-text-secondary" },
          { label: "Still dying", value: "$4,820", tone: "text-text" },
          { label: "Foxhound adds", value: "See after connecting", tone: "text-text-tertiary" },
        ].map((row) => (
          <div key={row.label} className="flex items-center justify-between border-b border-border-sub pb-3 last:border-0 last:pb-0">
            <span className="text-label text-text-secondary">{row.label}</span>
            <span className={`font-mono text-label font-medium ${row.tone}`}>{row.value}</span>
          </div>
        ))}
      </div>
      <p className="mt-4 text-micro text-text-tertiary">Detail collapsed below the summary until you open it.</p>
    </div>
  );
}

const BLOCKS = [
  {
    eyebrow: "What it checks",
    title: "Four scopes. One diagnostic.",
    body: "Failed invoices show what is unrecovered right now. Expiring cards show MRR at risk before the failure happens. Open disputes show deadlines. Business health shows MRR, ARR, and involuntary churn.",
    ui: <AuditScopePreview />,
  },
  {
    eyebrow: "Lift, not guesses",
    title: "What Stripe got, what is still dying, what Foxhound adds.",
    body: "The audit does not invent a recovery-rate projection. It shows what Stripe's own retries already recovered and what is still sitting unrecovered, plainly, with no platform-wide average standing in for your account's real numbers.",
    ui: <LiftPreview />,
  },
];

export default function AuditProductPage() {
  return (
    <>
      <ProductHero
        productName="Audit"
        Icon={ScanSearch}
        headline={
          <>
            See what your Stripe account is leaking.
            <br />
            Free.
          </>
        }
        sub="A full diagnostic across failed invoices, expiring cards, open disputes, and business health. No signup, no credit card, read-only Stripe access."
        pricing="Always free · No account required · Read-only Stripe access"
        primaryCTA={{ href: "/audit", label: "Run your free audit" }}
        secondaryCTA={{ href: "/docs/audit", label: "Read the guide" }}
      />
      <HowItWorks steps={STEPS} />
      <FeatureBlocks sectionLabel="What you get" blocks={BLOCKS} />
      <ProductPricing
        price="Free"
        priceLabel="Always. No strings."
        points={[
          "Four diagnostic scopes: failed invoices, expiring cards, disputes, business health",
          "No account required, no fabricated recovery-rate projections",
          "Persistent history once you create a free account",
          "Read-only Stripe access, your billing configuration is never touched",
        ]}
        ctaHref="/audit"
        ctaLabel="Run your free audit"
      />
      <ProductFAQ faqs={FAQS} />
      <BottomCTA
        title="Your Stripe account is telling you something."
        sub="The audit shows you what. Free, read-only, 30 seconds."
        ctaHref="/audit"
        ctaLabel="Run your free audit"
        note="No account required · Read-only access · Results in 30 seconds"
      />
    </>
  );
}
