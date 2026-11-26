import { marketingMeta } from "~/lib/seo/meta";
import { publicPageHeaders } from "@dustinedwards/site-runtime/edge-cache";
import { ButtonLink } from "capsomer/react/link";
import "capsomer/panel.css";
import "capsomer/status.css";
// Capsomer's tokens and the amber family (capbase layer), which the panel, the badge, the field, the select, the alert, the button and the focus ring read. The site header loads the same file; importing it here keeps the page whole under any layout.
import "~/site-header.css";

import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import { AUDIT_LOOKBACK_DAYS } from "~/lib/constants";
import { AUDIT_ACCESS_CHIP, AUDIT_GRANT_MINUTES } from "~/lib/marketing/audit-access";
import { siteUrl } from "~/lib/seo/jsonld";

import type { Route } from "./+types/audit";
import "~/audit-tool.css";

// The audit marketing page. No fabricated recovery-rate stat and no bare "2 to 3% of MRR fails every month" figure. Every card is Capsomer's panel and each call to action its primary button; the hero h1 clamp and the covers card's 40px padding are set through the parts' own variables.

export function meta({ loaderData }: Route.MetaArgs) {
  return [
    ...marketingMeta({
      title: "Free Stripe Revenue Leakage Audit",
      description:
        "See in 30 seconds what your Stripe account loses to failed payments, with no signup or credit card. Foxhound reads your real numbers.",
      path: "/audit",
      siteUrl: loaderData?.siteUrl ?? "",
    }),
  ];
}

export function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  return { siteUrl: siteUrl(env) };
}

// The covers card's four lines. The expiring-cards line says what the engine's predicate actually does, which includes already-expired cards. Four lines, not six: both engines compute six scopes; past-due subscriptions and the Card Updater advisory are folded into the run itself and render on the results page. There is no "historical win rate" line: it is a platform figure Foxhound does not render.
const COVERS: ReadonlyArray<readonly [string, string]> = [
  [
    "Failed invoices",
    `Payments Stripe marked uncollectible in the last ${AUDIT_LOOKBACK_DAYS} days, the decline reason behind each one, and the estimated recoverable amount.`,
  ],
  [
    "Expiring cards",
    "Customers whose card has expired or expires within the next month, and the MRR at risk before those payments fail.",
  ],
  [
    "Open disputes",
    "Unmanaged chargebacks, your won and lost record, and revenue accepted without evidence submission.",
  ],
  ["Business health", "MRR, ARR, active subscriptions, voluntary versus involuntary churn rate."],
];

export default function AuditPage() {
  return (
    // A 680px column, centered, px-4 md:px-8, py-10 md:py-20, in Capsomer's amber family with Foxhound's own neutrals (.fh-cap, as /demos and /pricing), comfortable density so each panel takes Capsomer's roomier padding.
    <div
      className="fh-audit-wrap fh-cap fh-center"
      data-cap-site="foxhound"
      data-family="amber"
      data-density="comfortable"
    >
      <h1 className="fh-audit-title fh-semibold fh-text">
        See everything leaking from your Stripe account
      </h1>

      <div className="fh-audit-grid-2">
        <section className="fh-audit-band cap-panel">
          <div className="cap-panel-body">
            <div>
              <h2 className="fh-audit-title-2 fh-caption fh-medium fh-quiet">
                What the audit covers
              </h2>
              <ul className="fh-audit-list">
                {COVERS.map(([title, desc]) => (
                  <li key={title} className="fh-audit-item fh-left">
                    <span className="fh-audit-label-2" aria-hidden="true" />
                    <span>
                      <span className="fh-audit-label-3 fh-line fh-copy fh-medium fh-text">
                        {title}
                      </span>
                      <span className="fh-line fh-small fh-faint">{desc}</span>
                    </span>
                  </li>
                ))}
              </ul>

              <ButtonLink
                to="/audit/connect"
                className="fh-audit-link fh-bold"
                variant="primary"
                size="lg"
                block
              >
                See my numbers
              </ButtonLink>
              <p className="fh-audit-text-2 fh-small fh-faint">
                {AUDIT_ACCESS_CHIP}. 30 seconds. No account required.
              </p>
            </div>
          </div>
        </section>
      </div>

      <div className="fh-audit-grid-4">
        <div className="cap-panel">
          <div className="cap-panel-body">
            <div>
              <p className="fh-audit-text-3 fh-mono fh-display fh-bold fh-green">
                {AUDIT_LOOKBACK_DAYS} days
              </p>
              <p className="fh-caption fh-faint">of failed invoices the audit reads</p>
            </div>
          </div>
        </div>
        <div className="cap-panel">
          <div className="cap-panel-body">
            <div>
              <p className="fh-audit-text-4 fh-mono fh-display fh-bold">$0</p>
              <p className="fh-caption fh-faint">cost to run this audit today</p>
            </div>
          </div>
        </div>
      </div>

      {/* A 24px target (min-h-6) for a link that stands alone. */}
      <a href="/demos/recovery" rel="nofollow" className="fh-audit-link-2 fh-copy fh-accent">
        View live demo &rarr;
      </a>

      <div className="fh-audit-grid-5">
        <div className="cap-panel">
          <div className="cap-panel-body">
            {/* SESSION 71, PHASE (f): the CTA is the audit, which needs no
                account and is the top of PRICING rev 3's funnel; signup is
                what the RESULTS page offers afterwards, which is where Recova
                puts it too. */}
            <div>
              <p className="fh-audit-text-7 fh-small fh-relaxed fh-soft">
                Connect Stripe and Foxhound runs the full audit on the spot: what failed and why,
                what is expiring, where your disputes stand, and your recurring revenue. No account
                needed. Foxhound only reads, writes nothing back to Stripe, and disconnects itself
                after {AUDIT_GRANT_MINUTES} minutes.
              </p>
              <ButtonLink to="/audit/connect" variant="primary">
                Run the free audit
              </ButtonLink>
              <p className="fh-audit-text-8 fh-mono fh-tiny fh-faint">
                No account required &middot; The audit only reads &middot; Nothing is stored
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export const headers = () => publicPageHeaders();
