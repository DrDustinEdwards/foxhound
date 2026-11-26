import { Icon, iconOverview, iconRefresh, iconShield, iconTrendingUp } from "capsomer/react/icons";
import { publicPageHeaders } from "@dustinedwards/site-runtime/edge-cache";
import { ButtonLink } from "capsomer/react/link";
import { MarketingPageHeader } from "~/components/marketing-page-header";
import { siteUrlLoader } from "~/lib/seo/site-url-loader";
import { marketingMeta } from "~/lib/seo/meta";

import "capsomer/panel.css";
import "capsomer/button.css";
// Capsomer's tokens and the amber family (capbase layer), which the panel, the button and the focus ring read. The site header loads the same file; importing it here keeps the page whole under any layout.
import "~/site-header.css";

import type { Route } from "./+types/demos";
import "~/products.css";

// The demo ENTRY point: each card is a real anchor into the REAL app surface for that product, each its own GET route under /demos/* (app/routes/demos/) that seeds and sets the demo cookie server-side before redirecting to a seeded, read-only demo account (the app-shell middleware injects a demo membership and blocks every write). A real <Link>, so the served HTML carries anchors into the demo (reachable by crawlers, bookmarkable); no <Form> fallback beside it. One row of four entry links: no product appears twice.

export function meta({ loaderData }: Route.MetaArgs) {
  return marketingMeta({
    title: "Live demo",
    description:
      "Explore the real Foxhound app with a full sample account: recovery sequences, dispute review, and MRR intelligence. No signup, nothing to connect.",
    path: "/demos",
    siteUrl: loaderData?.siteUrl ?? "",
  });
}

export const loader = siteUrlLoader;

const PRODUCT_ENTRIES = [
  {
    href: "/demos/dashboard",
    icon: iconOverview,
    name: "Dashboard",
    blurb: "Recovered revenue, recovery rate, and free MRR analytics at a glance.",
  },
  {
    href: "/demos/recovery",
    icon: iconRefresh,
    name: "Recovery",
    blurb: "AI-drafted email sequences and silent retries for a seeded account of 200 customers.",
  },
  {
    href: "/demos/disputes",
    icon: iconShield,
    name: "Disputes",
    blurb: "Evidence drafted for review, across won, lost, and needs-response states.",
  },
  {
    href: "/demos/intelligence",
    icon: iconTrendingUp,
    name: "Intelligence",
    blurb: "Every customer scored, MRR-at-risk exposure, and a monthly narrative.",
  },
];

export default function DemosPage() {
  return (
    <>
      <MarketingPageHeader
        title="The real product, with sample data"
        subtext="A seeded account of 200 customers. Nothing you do can change it."
      />

      <div className="fh-demos-wrap fh-cap" data-cap-site="foxhound" data-family="amber">
        <div className="fh-mk-cards-4" data-density="comfortable">
          {PRODUCT_ENTRIES.map((entry) => (
            <div key={entry.href} className="fh-demos-grid cap-reveal">
              <div className="cap-panel">
                <div className="cap-panel-body">
                  <div>
                    <p className="fh-body fh-medium fh-text">{entry.name}</p>
                    <p className="fh-demos-text fh-small fh-soft">{entry.blurb}</p>
                    {/* Capsomer's primary button as the link Recova draws full width. */}
                    <ButtonLink to={entry.href} rel="nofollow" variant="primary" block>
                      <Icon d={entry.icon} data-icon="start" />
                      View {entry.name} demo
                    </ButtonLink>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

export const headers = () => publicPageHeaders();
