import { Pill } from "capsomer/react/status";
import "capsomer/status.css";
import { formatDate } from "capsomer/behavior/time";
import { Link } from "capsomer/react/link";

import { BADGE_PILL } from "~/lib/recovery/labels";
import type { AttributionKind } from "~/lib/constants";
import { BILLING_LINE_ITEM_TYPE_LABELS } from "~/lib/billing/labels";
import type { EnrichedLineItem, FreeLedgerEntry } from "~/lib/billing/queries.server";
import { formatMoney } from "@dustinedwards/site-runtime/money";
import { ATTRIBUTION_KIND_LABELS, formatStepType } from "~/lib/recovery/labels";

// The shared "action -> recovery -> fee" chain rendering (DESIGN.md flagship
// surface 1), reused by /billing (the whole-account ledger) and
// /billing/invoices/:id (one invoice's own lines). Read-only: renders exactly
// what the billing engine already stored, never recomputes an amount.

function ChainRow({ children }: { children: React.ReactNode }) {
  return <li className="fh-ledger-row">{children}</li>;
}

function Header({
  typeLabel,
  amountCents,
  currency,
  date,
}: {
  typeLabel: string;
  amountCents: number;
  currency: string;
  date: Date;
}) {
  return (
    <div className="fh-split">
      <div className="fh-inline-row">
        <Pill {...BADGE_PILL.neutral}>{typeLabel}</Pill>
        <span className="fh-tiny fh-faint">{formatDate(date, { style: "medium" }) ?? ""}</span>
      </div>
      <p className="fh-mono fh-body fh-medium fh-text">{formatMoney(amountCents, currency)}</p>
    </div>
  );
}

/** One billed line item, chained to its evidence. */
export function LedgerLineItemRow({ entry }: { entry: EnrichedLineItem }) {
  const { lineItem, recoveredPayment, creditedStepType, dispute, adminAuditEntry } = entry;
  const typeLabel =
    BILLING_LINE_ITEM_TYPE_LABELS[lineItem.type as keyof typeof BILLING_LINE_ITEM_TYPE_LABELS] ??
    lineItem.type;

  return (
    <ChainRow>
      <Header
        typeLabel={typeLabel}
        amountCents={lineItem.amountCents}
        currency={lineItem.currency}
        date={lineItem.createdAt}
      />

      {lineItem.type === "recovery_fee" && recoveredPayment ? (
        <p className="fh-small fh-quiet">
          {ATTRIBUTION_KIND_LABELS[recoveredPayment.attributionKind as AttributionKind] ??
            recoveredPayment.attributionKind}
          {creditedStepType ? ` (${formatStepType(creditedStepType)})` : ""} on{" "}
          {formatDate(recoveredPayment.attributedAt ?? recoveredPayment.recoveredAt, {
            style: "medium",
          }) ?? ""}{" "}
          recovered{" "}
          <Link to={`/recovery/payments/${recoveredPayment.failedPaymentId}`}>
            {formatMoney(recoveredPayment.amountCents, recoveredPayment.currency)}
          </Link>{" "}
          on {formatDate(recoveredPayment.recoveredAt, { style: "medium" }) ?? ""}
        </p>
      ) : null}

      {lineItem.type === "dispute_fee" && dispute ? (
        <p className="fh-small fh-quiet">
          {dispute.customerName ?? dispute.customerEmail ?? dispute.stripeChargeId} won a{" "}
          {dispute.reason} dispute for {formatMoney(dispute.amountCents, dispute.currency)}
          {dispute.resolvedAt
            ? ` on ${formatDate(dispute.resolvedAt, { style: "medium" }) ?? ""}`
            : ""}
          . <Link to={`/disputes/${dispute.id}`}>View dispute</Link>
        </p>
      ) : null}

      {lineItem.type === "subscription" ? (
        <p className="fh-small fh-quiet">{lineItem.description ?? "Intelligence subscription"}</p>
      ) : null}

      {lineItem.type === "adjustment" ? (
        <p className="fh-small fh-quiet">
          {lineItem.description ?? "Manual adjustment"}
          {adminAuditEntry
            ? ` - approved by ${adminAuditEntry.actorEmail} (${adminAuditEntry.action})`
            : ""}
        </p>
      ) : null}
    </ChainRow>
  );
}

/** A baseline recovery: never billed, shown in the same ledger marked FREE. */
export function LedgerFreeRow({ entry }: { entry: FreeLedgerEntry }) {
  const { recoveredPayment } = entry;
  return (
    <ChainRow>
      <div className="fh-split">
        <div className="fh-inline-row">
          <Pill {...BADGE_PILL.neutral}>Stripe baseline - FREE</Pill>
          <span className="fh-tiny fh-faint">
            {formatDate(recoveredPayment.recoveredAt, { style: "medium" }) ?? ""}
          </span>
        </div>
        <p className="fh-mono fh-body fh-medium fh-quiet">
          {formatMoney(recoveredPayment.amountCents, recoveredPayment.currency)}
        </p>
      </div>
      <p className="fh-small fh-quiet">
        No Foxhound action preceded this recovery, Stripe's own retry recovered it.{" "}
        <Link to={`/recovery/payments/${recoveredPayment.failedPaymentId}`}>View payment</Link>
      </p>
    </ChainRow>
  );
}
