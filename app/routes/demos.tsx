import { RefreshCw, Shield, TrendingUp, LayoutDashboard } from "lucide-react";
import { Link } from "react-router";

import { MarketingPageHeader } from "~/components/marketing-page-header";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { siteUrl } from "~/lib/seo/jsonld";
import { marketingMeta } from "~/lib/seo/meta";

import type { Route } from "./+types/demos";

// The demo ENTRY point (audit priority #2). Not mock cards: each card is a
// real anchor into the REAL app surface for that product (recovery, disputes,
// intelligence), each its own GET route under /demos/* (app/routes/demos/)
// that seeds and sets the demo cookie server-side before redirecting. Pointed
// at a seeded demo account, read-only (the app-shell middleware injects a
// demo membership and blocks every write).
//
// TASK-foxhound-demo-entry-parity.md item 1: the prior version rendered each
// card as a <Form method="post"> button, so the served HTML carried zero
// anchors into the demo (unreachable by crawlers, unbookmarkable, no deep
// link). One path now: a real <Link>, no <Form> fallback beside it.

export function meta({ loaderData }: Route.MetaArgs) {
  return marketingMeta({
    title: "Live demo - Foxhound",
    description:
      "Explore the real Foxhound app with a full sample account: recovery sequences, dispute review, and MRR intelligence. No signup, nothing to connect.",
    path: "/demos",
    siteUrl: loaderData?.siteUrl ?? "",
  });
}

export function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  return { siteUrl: siteUrl(env) };
}

const PRODUCT_ENTRIES = [
  {
    href: "/demos/recovery",
    Icon: RefreshCw,
    name: "Recovery",
    blurb: "Silent retries first, then AI-drafted email sequences for a seeded account of 200 customers.",
  },
  {
    href: "/demos/disputes",
    Icon: Shield,
    name: "Disputes",
    blurb: "Evidence drafted for review, across won, lost, and needs-response states.",
  },
  {
    href: "/demos/intelligence",
    Icon: TrendingUp,
    name: "Intelligence",
    blurb: "Every customer scored, MRR-at-risk exposure, and a monthly narrative.",
  },
];

const SURFACES = [
  { Icon: LayoutDashboard, name: "Dashboard", blurb: "Recovered revenue, recovery rate, and free MRR analytics at a glance." },
  { Icon: RefreshCw, name: "Recovery", blurb: "Failed payments moving through real dunning sequences, with per-payment timelines." },
  { Icon: Shield, name: "Disputes", blurb: "Evidence drafted for review, across won, lost, and needs-response states." },
  { Icon: TrendingUp, name: "Intelligence", blurb: "Every customer scored, MRR-at-risk exposure, and a monthly narrative." },
];

export default function DemosPage() {
  return (
    <>
      <MarketingPageHeader
        eyebrow="Live demo"
        title="The real product, with sample data"
        subtext="This is not a screenshot tour. You'll be inside the actual Foxhound app, exploring a seeded account of 200 customers. No signup, nothing to connect, and nothing you do can change it."
      />

      <div className="mx-auto max-w-3xl px-4 pb-16 sm:px-8">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {PRODUCT_ENTRIES.map((entry) => (
            <Link
              key={entry.href}
              to={entry.href}
              className="flex w-full flex-col items-start gap-3 rounded-lg border border-border bg-surface p-5 text-left hover:border-border-i"
            >
              <div className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface2">
                <entry.Icon className="h-[18px] w-[18px] text-text-secondary" strokeWidth={1.8} aria-hidden />
              </div>
              <div>
                <p className="text-body font-medium text-text">{entry.name}</p>
                <p className="mt-1 text-label text-text-secondary">{entry.blurb}</p>
              </div>
              <span className="mt-1 font-mono text-micro text-amber-text">View {entry.name} demo</span>
            </Link>
          ))}
        </div>

        <div className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2">
          {SURFACES.map((s) => (
            <div key={s.name} className="flex gap-3 rounded-lg border border-border bg-surface p-5">
              <div className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface2">
                <s.Icon className="h-[18px] w-[18px] text-text-secondary" strokeWidth={1.8} aria-hidden />
              </div>
              <div>
                <p className="text-body font-medium text-text">{s.name}</p>
                <p className="mt-1 text-label text-text-secondary">{s.blurb}</p>
              </div>
            </div>
          ))}
        </div>

        <p className="mt-8 text-center text-label text-text-tertiary">
          The demo is read-only. When you're done, you can leave it from the banner at the top of the app.
        </p>
      </div>
    </>
  );
}
