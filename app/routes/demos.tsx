import { RefreshCw, Shield, TrendingUp, LayoutDashboard } from "lucide-react";
import { Form, redirect, useNavigation } from "react-router";

import { MarketingPageHeader } from "~/components/marketing-page-header";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { ensureDemoSeeded } from "~/lib/demo/seed";
import { setDemoCookieHeader } from "~/lib/demo/session";
import { siteUrl } from "~/lib/seo/jsonld";
import { marketingMeta } from "~/lib/seo/meta";

import type { Route } from "./+types/demos";

// The demo ENTRY point (audit priority #2). Not mock cards: each card drops
// the visitor into the REAL app surface for that product (recovery, disputes,
// intelligence) pointed at a seeded demo account, read-only (the app-shell
// middleware injects a demo membership and blocks every write). This page
// only frames the demo and sets the demo cookie.
//
// Three product entries (TASK-foxhound-demo-access-parity.md change 2):
// confirmed live on recova-eta.vercel.app/demos before writing this - legacy
// has a three-card hub (Recovery, Disputes, Intelligence), each card its own
// "View {product} demo" action, framed as "view the live product with sample
// data." Foxhound's version keeps that framing and card structure but drops
// legacy's standalone /recovery/demo-style replicas per the ratified
// direction (Fable 5, 2026-07-23): one app UI, seeded data, firewall intact,
// not a second, parallel demo implementation. Each card POSTs to this same
// action with its target product; the action seeds (unchanged) and redirects
// straight to that product instead of always to /dashboard.

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

// Target product per card, keyed by the hidden "product" field each card's
// form submits. Looked up rather than interpolated directly into the
// redirect path, so the destination can only ever be one of these three
// real routes regardless of what a request sends.
const PRODUCT_TARGETS: Record<string, string> = {
  recovery: "/recovery",
  disputes: "/disputes",
  intelligence: "/intelligence",
};

// Enter the demo for a specific product: ensure the demo account is seeded
// (idempotent; the daily demo-reset cron keeps it fresh, this just
// guarantees a first visitor is not dropped into an empty shell), set the
// read-only demo cookie, and land directly on that product's real page. This
// action runs in the marketing layout, so it is not itself gated by the demo
// read-only rule.
export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const form = await request.formData();
  const product = String(form.get("product") ?? "");
  const target = PRODUCT_TARGETS[product] ?? "/dashboard";
  await ensureDemoSeeded(env);
  return redirect(target, { headers: { "Set-Cookie": setDemoCookieHeader() } });
}

const PRODUCT_ENTRIES = [
  {
    key: "recovery",
    Icon: RefreshCw,
    name: "Recovery",
    blurb: "Silent retries first, then AI-drafted email sequences for a seeded account of 185 customers.",
  },
  {
    key: "disputes",
    Icon: Shield,
    name: "Disputes",
    blurb: "Evidence drafted for review, across won, lost, and needs-response states.",
  },
  {
    key: "intelligence",
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
  const navigation = useNavigation();
  const busyProduct = navigation.formData?.get("product");

  return (
    <>
      <MarketingPageHeader
        eyebrow="Live demo"
        title="The real product, with sample data"
        subtext="This is not a screenshot tour. You'll be inside the actual Foxhound app, exploring a seeded account of 185 customers. No signup, nothing to connect, and nothing you do can change it."
      />

      <div className="mx-auto max-w-3xl px-4 pb-16 sm:px-8">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {PRODUCT_ENTRIES.map((entry) => {
            const busy = busyProduct === entry.key;
            return (
              <Form key={entry.key} method="post" className="flex">
                <input type="hidden" name="product" value={entry.key} />
                <button
                  type="submit"
                  disabled={busy}
                  className="flex w-full flex-col items-start gap-3 rounded-lg border border-border bg-surface p-5 text-left hover:border-border-i disabled:opacity-60"
                >
                  <div className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface2">
                    <entry.Icon className="h-[18px] w-[18px] text-text-secondary" strokeWidth={1.8} aria-hidden />
                  </div>
                  <div>
                    <p className="text-body font-medium text-text">{entry.name}</p>
                    <p className="mt-1 text-label text-text-secondary">{entry.blurb}</p>
                  </div>
                  <span className="mt-1 font-mono text-micro text-amber-text">
                    {busy ? "Loading the demo..." : `View ${entry.name} demo`}
                  </span>
                </button>
              </Form>
            );
          })}
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
