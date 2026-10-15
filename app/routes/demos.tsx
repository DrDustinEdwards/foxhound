import { RefreshCw, Shield, TrendingUp, LayoutDashboard } from "lucide-react";
import { Link } from "react-router";

import { FadeUp } from "~/components/fade-up";
import { MarketingPageHeader } from "~/components/marketing-page-header";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { siteUrl } from "~/lib/seo/jsonld";
import { marketingMeta } from "~/lib/seo/meta";

import "capsomer/panel.css";
import "capsomer/button.css";
// Capsomer's tokens and the teal family (capbase layer), which the panel, the
// button and the focus ring read. The site header loads the same file;
// importing it here keeps the page whole under any layout.
import "~/site-header.css";

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
//
// Item 2: a second, static block below used to repeat Recovery/Disputes/
// Intelligence with no action of any kind, and introduced Dashboard as the
// one surface a visitor could see named but never reach. Collapsed into this
// single row of four real entry links instead: no product appears twice,
// once clickable and once not.

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
    href: "/demos/dashboard",
    Icon: LayoutDashboard,
    name: "Dashboard",
    blurb: "Recovered revenue, recovery rate, and free MRR analytics at a glance.",
  },
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

export default function DemosPage() {
  return (
    <>
      <MarketingPageHeader
        eyebrow="Live demo"
        title="The real product, with sample data"
        subtext="This is not a screenshot tour. You'll be inside the actual Foxhound app, exploring a seeded account of 200 customers. No signup, nothing to connect, and nothing you do can change it."
      />

      {/* Recova's 1200px column (px-4, md:px-8, pb-16), in Capsomer's teal
          family with Foxhound's own neutrals (.fh-cap, as /pricing and the
          /products hub). The buttons are the only focusable parts here; their
          teal ring is Capsomer's own, handed back by app.css
          (.fh-cap .cap-btn:focus-visible). */}
      <div className="fh-cap mx-auto max-w-[1200px] px-4 pb-16 md:px-8" data-family="teal">
        {/* Four cards against legacy's three: legacy filters to products with a
            demoHref, Foxhound also entry-points the console demo. Ratified
            (Dustin, 2026-07-31, "Four demo cards, in Recova's treatment") on
            the five-nav-entries precedent, that a working page is never
            orphaned to win an item-set parity point, so the grid stays 4-up
            where legacy runs md:grid-cols-3.

            Each card is Capsomer's panel, body only, in its comfortable
            density: 24px sides as Recova's p-6, 16px top and bottom where
            Recova has 24px, 10px corners where Recova has 12px. Those are
            Capsomer's panel as it ships; a Foxhound variant waits for
            Capsomer's per-site layer (capsomer job_ec5ec0754626). FadeUp,
            Recova's reveal, is a one-cell grid so the panel fills the row.
            The panel's body does not fill the panel, so a button sits under
            its own blurb rather than at the foot of a taller neighbour, as
            on the blog's cards (J19); that is the layer's too. */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4" data-density="comfortable">
          {PRODUCT_ENTRIES.map((entry, index) => (
            <FadeUp key={entry.href} delay={index * 100} className="grid">
              <div className="cap-panel">
                <div className="cap-panel-body">
                  {/* One block, so the body's grid gap leaves Recova's own spacing alone. */}
                  <div>
                    <p className="text-body font-medium text-text">{entry.name}</p>
                    <p className="mb-6 mt-2 text-label text-text-secondary">{entry.blurb}</p>
                    {/* Capsomer's primary button as the link Recova draws full
                        width: the one-column grid stretches it, so the button
                        carries no Foxhound class. */}
                    <div className="grid">
                      <Link to={entry.href} className="cap-btn" data-variant="primary">
                        <entry.Icon data-icon="start" strokeWidth={2} aria-hidden />
                        View {entry.name} demo
                      </Link>
                    </div>
                  </div>
                </div>
              </div>
            </FadeUp>
          ))}
        </div>

        <p className="mt-8 text-center text-label text-text-subtle">
          The demo is read-only. When you're done, you can leave it from the banner at the top of the app.
        </p>
      </div>
    </>
  );
}
