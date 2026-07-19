import { RefreshCw, Shield, TrendingUp } from "lucide-react";
import { Link } from "react-router";

import { Badge } from "~/components/badge";
import { MarketingPageHeader } from "~/components/marketing-page-header";
import { StatCard } from "~/components/stat-card";

// Ported from legacy app/(marketing)/demos/page.tsx (Phase 6 Pass 1).
// Legacy linked out to separate /recovery/demo, /disputes/demo,
// /intelligence/demo routes and read the logged-in user to hide a
// "sign in" hint. Neither exists in ROUTES.md's Pass 1 manifest (only
// /demos itself), and marketing pages are static-render with no session
// reads, so this renders illustrative previews inline instead of linking to
// unbuilt routes, and drops the auth check.

export function meta() {
  return [
    { title: "Demos - Foxhound" },
    {
      name: "description",
      content:
        "See what Foxhound looks like before you connect anything. Recovery sequences, dispute review, and MRR intelligence, with sample data.",
    },
  ];
}

function RecoveryPreview() {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between rounded-lg border border-border-sub bg-bg px-3 py-2">
        <span className="text-label text-text">Silent retry</span>
        <Badge tone="success">Recovered</Badge>
      </div>
      <div className="flex items-center justify-between rounded-lg border border-border-sub bg-bg px-3 py-2">
        <span className="text-label text-text">Email 1</span>
        <Badge tone="neutral">Not needed</Badge>
      </div>
    </div>
  );
}

function DisputesPreview() {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between rounded-lg border border-border-sub bg-bg px-3 py-2">
        <span className="text-label text-text">Evidence draft</span>
        <Badge tone="neutral">Pending review</Badge>
      </div>
      <div className="flex items-center justify-between rounded-lg border border-border-sub bg-bg px-3 py-2">
        <span className="text-label text-text">Your approval</span>
        <Badge tone="neutral">Required</Badge>
      </div>
    </div>
  );
}

function IntelligencePreview() {
  return (
    <div className="grid grid-cols-2 gap-2">
      <StatCard label="MRR" value="$18.4k" />
      <StatCard label="Churn" value="2.1%" />
    </div>
  );
}

const DEMOS = [
  {
    key: "recovery",
    name: "Recovery",
    description: "Silent retries first, then a 30-day email sequence. See how a payment moves through it.",
    Icon: RefreshCw,
    preview: <RecoveryPreview />,
    href: "/products/recovery",
  },
  {
    key: "disputes",
    name: "Disputes",
    description: "Evidence drafted automatically, held for your review and sign-off before anything submits.",
    Icon: Shield,
    preview: <DisputesPreview />,
    href: "/products/disputes",
  },
  {
    key: "intelligence",
    name: "Intelligence",
    description: "MRR and churn analytics, free with every Recovery account.",
    Icon: TrendingUp,
    preview: <IntelligencePreview />,
    href: "/products/intelligence",
  },
];

export default function DemosPage() {
  return (
    <>
      <MarketingPageHeader
        eyebrow="Demos"
        title="Try before you connect"
        subtext="See what Foxhound looks like before linking your Stripe account. No signup required."
      />

      <div className="mx-auto max-w-5xl px-4 pb-16 sm:px-8">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {DEMOS.map((demo) => (
            <div key={demo.key} className="flex flex-col rounded-lg border border-border bg-surface p-6">
              <div className="mb-4 inline-flex h-10 w-10 items-center justify-center rounded-lg bg-surface2">
                <demo.Icon className="h-[18px] w-[18px] text-text-secondary" strokeWidth={1.8} aria-hidden />
              </div>
              <p className="text-body font-medium text-text">{demo.name}</p>
              <p className="mb-4 mt-2 flex-1 text-label text-text-secondary">{demo.description}</p>
              <div className="mb-5">{demo.preview}</div>
              <Link
                to={demo.href}
                className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-amber py-2.5 text-label font-medium text-on-amber hover:bg-amber-dark"
              >
                <demo.Icon className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
                See {demo.name} in detail
              </Link>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
