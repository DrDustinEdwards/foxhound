import { RefreshCw, Shield, TrendingUp, LayoutDashboard } from "lucide-react";
import { Form, redirect, useNavigation } from "react-router";

import { MarketingPageHeader } from "~/components/marketing-page-header";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { ensureDemoSeeded } from "~/lib/demo/seed";
import { setDemoCookieHeader } from "~/lib/demo/session";

import type { Route } from "./+types/demos";

// The demo ENTRY point (audit priority #2). Not mock cards: the "See the live
// demo" button drops the visitor into the REAL app surfaces (dashboard, recovery,
// disputes, intelligence) pointed at a seeded demo account, read-only (the
// app-shell middleware injects a demo membership and blocks every write). This
// page only frames the demo and sets the demo cookie.

export function meta() {
  return [
    { title: "Live demo - Foxhound" },
    {
      name: "description",
      content:
        "Explore the real Foxhound app with a full sample account: recovery sequences, dispute review, and MRR intelligence. No signup, nothing to connect.",
    },
  ];
}

// Enter the demo: ensure the demo account is seeded (idempotent; the daily
// demo-reset cron keeps it fresh, this just guarantees a first visitor is not
// dropped into an empty shell), set the read-only demo cookie, and land on the
// real dashboard. This action runs in the marketing layout, so it is not itself
// gated by the demo read-only rule.
export async function action({ context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  await ensureDemoSeeded(env);
  return redirect("/dashboard", { headers: { "Set-Cookie": setDemoCookieHeader() } });
}

const SURFACES = [
  { Icon: LayoutDashboard, name: "Dashboard", blurb: "Recovered revenue, recovery rate, and free MRR analytics at a glance." },
  { Icon: RefreshCw, name: "Recovery", blurb: "Failed payments moving through real dunning sequences, with per-payment timelines." },
  { Icon: Shield, name: "Disputes", blurb: "Evidence drafted for review, across won, lost, and needs-response states." },
  { Icon: TrendingUp, name: "Intelligence", blurb: "Every customer scored, MRR-at-risk exposure, and a monthly narrative." },
];

export default function DemosPage() {
  const busy = useNavigation().state !== "idle";

  return (
    <>
      <MarketingPageHeader
        eyebrow="Live demo"
        title="The real product, with sample data"
        subtext="This is not a screenshot tour. You'll be inside the actual Foxhound app, exploring a seeded account of 185 customers. No signup, nothing to connect, and nothing you do can change it."
      />

      <div className="mx-auto max-w-3xl px-4 pb-16 sm:px-8">
        <Form method="post" className="flex justify-center">
          <button
            type="submit"
            disabled={busy}
            className="inline-flex items-center justify-center gap-2 rounded-md bg-amber px-6 py-3 text-body font-medium text-on-amber hover:bg-amber-dark disabled:opacity-60"
          >
            {busy ? "Loading the demo..." : "See the live demo"}
          </button>
        </Form>

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
