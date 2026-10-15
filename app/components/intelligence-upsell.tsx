import { Link } from "react-router";

// The paid Intelligence layer's read-side gate (app/lib/intelligence/views.server.ts
// isIntelligenceEntitled) renders this instead of scores/predictions/alerts/
// narrative for a non-entitled account. An honest upsell, never fabricated data
// (TASK-foxhound-intelligence-ai.md: "a free merchant sees an honest upsell
// state, not fabricated scores"). Free Recovery merchants keep the free MRR
// analytics tier already on /console; this is the paid layer's own surface.
export function IntelligenceUpsell() {
  return (
    <div className="mt-6 rounded-lg border border-dashed border-border p-8 text-center">
      <p className="text-body text-text-tertiary">
        Intelligence is a $199/month add-on for Recovery merchants: risk scoring on every
        customer, MRR-at-risk exposure, alerts, and a nightly AI analyst narrative.
      </p>
      <Link
        to="/product/intelligence"
        className="mt-4 inline-block rounded-md bg-brand px-4 py-2 text-label font-medium text-on-brand hover:bg-brand-dark"
      >
        Learn about Intelligence
      </Link>
    </div>
  );
}
