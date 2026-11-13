import { useState } from "react";
import { ButtonLink } from "capsomer/react/link";

import { RECOVERY_FEE_BPS, RECOVERY_MATURITY_DAYS } from "~/lib/constants";
import { AUDIT_ACCESS_CHIP } from "~/lib/marketing/audit-access";
import { calculatorFigures, fmt } from "~/lib/marketing/calculator-math";
import { STAT_AS_OF, STRIPE_RECOVERY_RATE_PERCENT } from "~/lib/marketing/statistics";

import { RangeField } from "capsomer/react/field";

import "capsomer/panel.css";
import "capsomer/button.css";
import "capsomer/field.css";

/** The slider's starting position. An ASSUMPTION the visitor may change, never a
 *  Foxhound result: 52 is where the page has always started and is kept so the
 *  first render is unchanged. */
const DEFAULT_ASSUMED_RECOVERY_SHARE = 52;

/** The failure slider's starting position, also an ASSUMPTION the visitor may
 *  change. It replaced "About 8% of MRR fails on average" (2026-10-30), a
 *  statistic with no page or date behind it (CLAUDE.md hard rule 1); no
 *  verifiable public source for a share of MRR that fails was found. 8 is kept
 *  so the first render's figures are unchanged. */
const DEFAULT_ASSUMED_FAILURE_SHARE = 8;

const percent = (value: number) => `${value}%`;

// Recova's components/marketing/RecoveryCalculator.tsx (blob 1a4374f5), read
// whole: pure client math, unchanged multipliers, Recova's rows in Recova's
// order. The changes: the second slider (approved 2026-08-26 and 2026-09-19),
// the attribution and maturity labels (sanctioned, M3 divergences 31 and 32),
// and the look, which is Capsomer's: the card is a panel and the call to
// action its primary button, at Recova's sizes and padding (p-6, p-8 from sm).
// The sliders are Capsomer's RangeField: its Range (a 4px track filled in amber
// up to a round amber thumb, as Recova's were), the value read out at the end of
// the label's line and the words under each end, in Recova's label and end type.
export function RecoveryCalculator() {
  const [mrr, setMrr] = useState(25000);
  // THE RECOVERY SHARE IS THE VISITOR'S ASSUMPTION, NOT FOXHOUND'S CLAIM.
  // It used to be a hardcoded share with a footnote calling it
  // illustrative, which is a Foxhound recovery rate in everything but name:
  // every visitor saw the same number and it was ours. Foxhound has no ledger to
  // draw a rate from and the docs refuse to project one, so the only honest
  // version of this control is one the reader sets. The default stays at 52 so
  // the page looks the same on arrival; what changed is who owns the number.
  const [recoveryShare, setRecoveryShare] = useState(DEFAULT_ASSUMED_RECOVERY_SHARE);

  const [failureShare, setFailureShare] = useState(DEFAULT_ASSUMED_FAILURE_SHARE);

  const {
    failedRevenue,
    stripeRecovers,
    remaining,
    foxhoundRecovers,
    foxhoundFee,
    netGain,
    netGainAnnual,
  } = calculatorFigures({
    mrr,
    failureShare,
    recoveryShare,
    stripeRecoveryRatePercent: STRIPE_RECOVERY_RATE_PERCENT,
    recoveryFeeBps: RECOVERY_FEE_BPS,
  });

  return (
    // On a page that does not hydrate, the calculator island (islands/calculator.ts) runs the same math
    // on the same markup; data-calc names each figure it writes.
    <div
      className="cap-panel [--gap:1.5rem] [--pad-card:1.5rem] sm:[--gap:2rem] sm:[--pad-card:2rem]"
      data-island="calculator"
      data-props={JSON.stringify({
        stripeRecoveryRatePercent: STRIPE_RECOVERY_RATE_PERCENT,
        recoveryFeeBps: RECOVERY_FEE_BPS,
      })}
    >
      <div className="cap-panel-body">
        <div>
          <div className="mb-6">
            <RangeField
              id="mrr-slider"
              label={
                <span className="font-mono text-micro uppercase tracking-widest text-text-tertiary">
                  Monthly recurring revenue
                </span>
              }
              min={1000}
              max={500000}
              step={1000}
              value={mrr}
              onChange={setMrr}
              format={fmt}
              minLabel={<span className="font-mono text-source text-text-subtle">$1k</span>}
              maxLabel={<span className="font-mono text-source text-text-subtle">$500k</span>}
              // React itself injects a client-only style.caretColor on controlled
              // range inputs during hydration (a Firefox thumb-rendering
              // workaround baked into react-dom, not app markup), which is absent
              // from the SSR HTML and otherwise logs a false-positive hydration
              // mismatch warning on every load of this page.
              suppressHydrationWarning
            />
          </div>

          <div className="mb-6">
            <RangeField
              id="failure-share-slider"
              label={
                <span className="font-mono text-micro uppercase tracking-widest text-text-tertiary">
                  Assumed share of MRR that fails
                </span>
              }
              min={0}
              max={20}
              step={1}
              value={failureShare}
              onChange={setFailureShare}
              format={percent}
              minLabel={<span className="font-mono text-source text-text-subtle">0%</span>}
              maxLabel={<span className="font-mono text-source text-text-subtle">20%</span>}
              // Same react-dom hydration workaround as the slider above.
              suppressHydrationWarning
            />
          </div>

          <div className="mb-6">
            <RangeField
              id="recovery-share-slider"
              label={
                <span className="font-mono text-micro uppercase tracking-widest text-text-tertiary">
                  Assumed recovery of the remainder
                </span>
              }
              min={0}
              max={100}
              step={1}
              value={recoveryShare}
              onChange={setRecoveryShare}
              format={percent}
              minLabel={<span className="font-mono text-source text-text-subtle">0%</span>}
              maxLabel={<span className="font-mono text-source text-text-subtle">100%</span>}
              // Same react-dom hydration workaround as the slider above.
              suppressHydrationWarning
            />
          </div>

          <div className="mb-6 flex flex-col gap-3">
            <Row
              name="failedRevenue"
              label="Failed payments per month"
              sub={`${failureShare}% of MRR, the share you set above`}
              value={fmt(failedRevenue)}
            />
            <Row
              name="stripeRecovers"
              label="Stripe Smart Retries recover"
              sub={`${STRIPE_RECOVERY_RATE_PERCENT}% average, stripe.com/billing, read ${STAT_AS_OF}`}
              value={fmt(stripeRecovers)}
              valueClassName="text-text-secondary"
            />
            <Row
              name="remaining"
              label="Your recoverable opportunity"
              sub="What Stripe's own retries could not get back"
              value={fmt(remaining)}
              valueClassName="text-accent-text"
            />
            <Row
              name="foxhoundRecovers"
              label="Foxhound recovers from that"
              sub="Billable only when a Foxhound action provably preceded payment"
              value={fmt(foxhoundRecovers)}
              valueClassName="text-success-text"
            />
            <Row
              name="foxhoundFee"
              label="Foxhound fee"
              sub={`${RECOVERY_FEE_BPS / 100}% of what Foxhound recovers, nothing else, ever`}
              value={`-${fmt(foxhoundFee)}`}
              valueClassName="text-text-secondary"
            />
            <div className="flex items-center justify-between py-3">
              <div>
                <p className="text-subhead font-medium text-text">Net revenue retained</p>
                <p className="mt-0.5 font-mono text-micro text-text-tertiary">
                  Nothing is billed until the recovery has matured for {RECOVERY_MATURITY_DAYS}{" "}
                  days.
                </p>
              </div>
              <div className="text-right">
                <p className="font-mono text-title font-semibold text-success-text">
                  <span data-calc="netGainAnnual">{`+${fmt(netGainAnnual)}`}</span>
                  <span className="text-caption font-normal text-text-tertiary">/yr</span>
                </p>
                {/* Recova dims this line to 70%, which takes it and its "/mo" under
                4.5:1 in both themes (measured 3.02 and 3.29). Full strength here. */}
                <p className="mt-0.5 font-mono text-subhead font-medium text-success-text">
                  <span data-calc="netGain">{`+${fmt(netGain)}`}</span>
                  <span className="text-micro font-normal text-text-tertiary">/mo</span>
                </p>
              </div>
            </div>
          </div>

          <p className="mb-6 text-center font-mono text-source text-text-subtle">
            Stripe {STRIPE_RECOVERY_RATE_PERCENT}% recovery: stripe.com/billing, read {STAT_AS_OF}.
            The failure and recovery shares are assumptions you set, not Foxhound results: Foxhound
            does not project a failure or recovery rate.
          </p>

          <div className="flex justify-center">
            <ButtonLink
              to="/audit"
              className="w-full px-6 font-semibold sm:w-auto sm:min-w-[280px] [--cap-btn-h:3rem]"
              variant="primary"
              size="lg"
            >
              Get your actual numbers free
            </ButtonLink>
          </div>
          {/* Recova's line, with its third chip made true: Recova said "Read-only
          Stripe access", but Stripe gives read_only only to Extensions
          (2026-10-29), so the audit asks for read_write, only reads, and
          disconnects itself when its window ends (audit-access.ts). */}
          <p className="mt-3 text-center font-mono text-micro text-text-subtle">
            Free audit &middot; No account required &middot; {AUDIT_ACCESS_CHIP}
          </p>
        </div>
      </div>
    </div>
  );
}

function Row({
  name,
  label,
  sub,
  value,
  valueClassName = "text-text",
}: {
  /** What the calculator island calls this figure (data-calc). */
  name: string;
  label: string;
  sub: string;
  value: string;
  valueClassName?: string;
}) {
  return (
    <div className="flex items-center justify-between border-b border-border-sub py-3">
      <div>
        <p className="text-copy text-text">{label}</p>
        <p className="mt-0.5 font-mono text-micro text-text-tertiary" data-calc={`${name}-sub`}>
          {sub}
        </p>
      </div>
      <div className={`font-mono text-subhead font-medium ${valueClassName}`} data-calc={name}>
        {value}
      </div>
    </div>
  );
}
