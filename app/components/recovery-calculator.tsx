import { useState } from "react";
import { Link } from "react-router";

import { RECOVERY_FEE_BPS, RECOVERY_MATURITY_DAYS } from "~/lib/constants";
import { STAT_AS_OF, STRIPE_RECOVERY_RATE_PERCENT } from "~/lib/marketing/statistics";

import "capsomer/panel.css";
import "capsomer/button.css";

/** The slider's starting position. An ASSUMPTION the visitor may change, never a
 *  Foxhound result: 52 is where the page has always started and is kept so the
 *  first render is unchanged. */
const DEFAULT_ASSUMED_RECOVERY_SHARE = 52;

// Recova's components/marketing/RecoveryCalculator.tsx (blob 1a4374f5), read
// whole: pure client math, unchanged multipliers, Recova's rows in Recova's
// order. The changes: the second slider (approved 2026-08-26 and 2026-09-19),
// the attribution and maturity labels (sanctioned, M3 divergences 31 and 32),
// and the look (J59), which is Capsomer's: the card is a panel and the call to
// action its primary button, with text on the five sizes. Recova's slider has
// a filled track; Capsomer ships no slider, so the native range input
// takes the family's accent and the filled track is named as a Capsomer gap.
export function RecoveryCalculator() {
  const [mrr, setMrr] = useState(25000);
  // THE RECOVERY SHARE IS THE VISITOR'S ASSUMPTION, NOT FOXHOUND'S CLAIM
  // (377(9)). It used to be a hardcoded share with a footnote calling it
  // illustrative, which is a Foxhound recovery rate in everything but name:
  // every visitor saw the same number and it was ours. Foxhound has no ledger to
  // draw a rate from and the docs refuse to project one, so the only honest
  // version of this control is one the reader sets. The default stays at 52 so
  // the page looks the same on arrival; what changed is who owns the number.
  const [recoveryShare, setRecoveryShare] = useState(DEFAULT_ASSUMED_RECOVERY_SHARE);

  const failedRevenue = Math.round(mrr * 0.08); // 8% of MRR fails
  const stripeRecovers = Math.round(failedRevenue * (STRIPE_RECOVERY_RATE_PERCENT / 100));
  const remaining = failedRevenue - stripeRecovers; // what Stripe could not get
  const foxhoundRecovers = Math.round(remaining * (recoveryShare / 100));
  const foxhoundFee = Math.round((foxhoundRecovers * RECOVERY_FEE_BPS) / 10_000); // the outcome fee
  const netGain = foxhoundRecovers - foxhoundFee; // net to merchant
  const netGainAnnual = netGain * 12;

  function fmt(n: number) {
    return "$" + n.toLocaleString();
  }

  return (
    <div className="cap-panel" data-density="comfortable">
      <div className="cap-panel-body">
      <div>
      <div className="mb-6">
        <div className="mb-2 flex items-center justify-between">
          <label
            htmlFor="mrr-slider"
            className="font-mono text-micro uppercase tracking-wide text-text-tertiary"
          >
            Monthly recurring revenue
          </label>
          <span className="font-mono text-body font-medium text-text">{fmt(mrr)}</span>
        </div>
        <input
          id="mrr-slider"
          type="range"
          min={1000}
          max={500000}
          step={1000}
          value={mrr}
          onChange={(e) => setMrr(Number(e.target.value))}
          className="h-6 w-full accent-brand"
          aria-valuemin={1000}
          aria-valuemax={500000}
          aria-valuenow={mrr}
          aria-valuetext={fmt(mrr)}
          // React itself injects a client-only style.caretColor on controlled
          // range inputs during hydration (a Firefox thumb-rendering
          // workaround baked into react-dom, not app markup), which is absent
          // from the SSR HTML and otherwise logs a false-positive hydration
          // mismatch warning on every load of this page.
          suppressHydrationWarning
        />
        <div className="mt-1 flex justify-between">
          <span className="font-mono text-micro text-text-subtle">$1k</span>
          <span className="font-mono text-micro text-text-subtle">$500k</span>
        </div>
      </div>

      <div className="mb-6">
        <div className="mb-2 flex items-center justify-between">
          <label
            htmlFor="recovery-share-slider"
            className="font-mono text-micro uppercase tracking-wide text-text-tertiary"
          >
            Assumed recovery of the remainder
          </label>
          <span className="font-mono text-body font-medium text-text">{recoveryShare}%</span>
        </div>
        <input
          id="recovery-share-slider"
          type="range"
          min={0}
          max={100}
          step={1}
          value={recoveryShare}
          onChange={(e) => setRecoveryShare(Number(e.target.value))}
          className="h-6 w-full accent-brand"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={recoveryShare}
          aria-valuetext={`${recoveryShare}%`}
          // Same react-dom hydration workaround as the slider above.
          suppressHydrationWarning
        />
        <div className="mt-1 flex justify-between">
          <span className="font-mono text-micro text-text-subtle">0%</span>
          <span className="font-mono text-micro text-text-subtle">100%</span>
        </div>
      </div>

      <div className="mb-6 flex flex-col">
        <Row
          label="Failed payments per month"
          sub="About 8% of MRR fails on average"
          value={fmt(failedRevenue)}
        />
        <Row
          label="Stripe Smart Retries recover"
          sub={`${STRIPE_RECOVERY_RATE_PERCENT}% average, stripe.com/billing, read ${STAT_AS_OF}`}
          value={fmt(stripeRecovers)}
          valueClassName="text-text-secondary"
        />
        <Row
          label="Your recoverable opportunity"
          sub="What Stripe's own retries could not get back"
          value={fmt(remaining)}
        />
        <Row
          label="Foxhound recovers from that"
          sub="Billable only when a Foxhound action provably preceded payment"
          value={fmt(foxhoundRecovers)}
          valueClassName="text-success-text"
        />
        <Row
          label="Foxhound fee"
          sub={`${RECOVERY_FEE_BPS / 100}% of what Foxhound recovers, nothing else, ever`}
          value={`-${fmt(foxhoundFee)}`}
          valueClassName="text-text-secondary"
        />
        <div className="flex items-center justify-between py-3">
          <div>
            <p className="text-body font-medium text-text">Net revenue retained</p>
            <p className="mt-0.5 font-mono text-micro text-text-tertiary">
              Nothing is billed until the recovery has matured for {RECOVERY_MATURITY_DAYS} days.
            </p>
          </div>
          <div className="text-right">
            <p className="font-mono text-title font-semibold text-success-text">
              +{fmt(netGainAnnual)}
              <span className="text-label font-normal text-text-tertiary">/yr</span>
            </p>
            {/* Recova dims this line to 70%, which takes it and its "/mo" under
                4.5:1 in both themes (measured 3.02 and 3.29). Full strength here
                (RULES.md 1.5). */}
            <p className="mt-0.5 font-mono text-body font-medium text-success-text">
              +{fmt(netGain)}
              <span className="text-micro font-normal text-text-tertiary">/mo</span>
            </p>
          </div>
        </div>
      </div>

      <p className="mb-6 text-center font-mono text-micro text-text-subtle">
        Stripe {STRIPE_RECOVERY_RATE_PERCENT}% recovery: stripe.com/billing, read {STAT_AS_OF}. The
        recovery share is an assumption you set, not a Foxhound result: Foxhound does not project a
        recovery rate.
      </p>

      <div className="flex justify-center" data-density="comfortable">
        <Link to="/audit" className="cap-btn" data-variant="primary" data-size="lg">
          Get your actual numbers free
        </Link>
      </div>
      {/* Recova's line, word for word. The full audit is a read-only Stripe
          connection (362 ruling 1, RULES.md 2.2), so "Read-only Stripe access"
          is true of where this button goes. */}
      <p className="mt-3 text-center font-mono text-micro text-text-subtle">
        Free audit &middot; No account required &middot; Read-only Stripe access
      </p>
      </div>
      </div>
    </div>
  );
}

function Row({
  label,
  sub,
  value,
  valueClassName = "text-text",
}: {
  label: string;
  sub: string;
  value: string;
  valueClassName?: string;
}) {
  return (
    <div className="flex items-center justify-between border-b border-border-sub py-3">
      <div>
        <p className="text-label text-text">{label}</p>
        <p className="mt-0.5 font-mono text-micro text-text-tertiary">{sub}</p>
      </div>
      <div className={`font-mono text-body font-medium ${valueClassName}`}>{value}</div>
    </div>
  );
}
