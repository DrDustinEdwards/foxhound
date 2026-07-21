import { Link } from "react-router";

import { Badge } from "~/components/badge";
import type { AttributionKind } from "~/lib/constants";
import { BILLING_LINE_ITEM_TYPE_LABELS } from "~/lib/billing/labels";
import type { EnrichedLineItem, FreeLedgerEntry } from "~/lib/billing/queries.server";
import { formatMoney } from "~/lib/money-format";
import { ATTRIBUTION_KIND_LABELS, formatStepType } from "~/lib/recovery/labels";

// The shared "action -> recovery -> fee" chain rendering (DESIGN.md flagship
// surface 1), reused by /billing (the whole-account ledger) and
// /billing/invoices/:id (one invoice's own lines). Read-only: renders exactly
// what the billing engine already stored, never recomputes an amount.

function ChainRow({ children }: { children: React.ReactNode }) {
  return <li className="flex flex-col gap-2 border-b border-border-sub py-3 last:border-0">{children}</li>;
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
    <div className="flex items-start justify-between gap-4">
      <div className="flex items-center gap-2">
        <Badge tone="neutral">{typeLabel}</Badge>
        <span className="text-micro text-text-subtle">{date.toLocaleDateString()}</span>
      </div>
      <p className="font-mono text-body font-medium text-text">{formatMoney(amountCents, currency)}</p>
    </div>
  );
}

/** One billed line item, chained to its evidence. */
export function LedgerLineItemRow({ entry }: { entry: EnrichedLineItem }) {
  const { lineItem, recoveredPayment, creditedStepType, dispute, adminAuditEntry } = entry;
  const typeLabel = BILLING_LINE_ITEM_TYPE_LABELS[lineItem.type as keyof typeof BILLING_LINE_ITEM_TYPE_LABELS] ?? lineItem.type;

  return (
    <ChainRow>
      <Header typeLabel={typeLabel} amountCents={lineItem.amountCents} currency={lineItem.currency} date={lineItem.createdAt} />

      {lineItem.type === "recovery_fee" && recoveredPayment ? (
        <p className="text-label text-text-tertiary">
          {ATTRIBUTION_KIND_LABELS[recoveredPayment.attributionKind as AttributionKind] ?? recoveredPayment.attributionKind}
          {creditedStepType ? ` (${formatStepType(creditedStepType)})` : ""} on{" "}
          {(recoveredPayment.attributedAt ?? recoveredPayment.recoveredAt).toLocaleDateString()} recovered{" "}
          <Link to={`/recovery/payments/${recoveredPayment.failedPaymentId}`} className="text-amber-text hover:underline">
            {formatMoney(recoveredPayment.amountCents, recoveredPayment.currency)}
          </Link>{" "}
          on {recoveredPayment.recoveredAt.toLocaleDateString()}
        </p>
      ) : null}

      {lineItem.type === "dispute_fee" && dispute ? (
        <p className="text-label text-text-tertiary">
          {dispute.customerName ?? dispute.customerEmail ?? dispute.stripeChargeId} won a {dispute.reason}{" "}
          dispute for {formatMoney(dispute.amountCents, dispute.currency)}
          {dispute.resolvedAt ? ` on ${dispute.resolvedAt.toLocaleDateString()}` : ""}.{" "}
          <Link to={`/disputes/${dispute.id}`} className="text-amber-text hover:underline">
            View dispute
          </Link>
        </p>
      ) : null}

      {lineItem.type === "subscription" ? (
        <p className="text-label text-text-tertiary">{lineItem.description ?? "Intelligence subscription"}</p>
      ) : null}

      {lineItem.type === "adjustment" ? (
        <p className="text-label text-text-tertiary">
          {lineItem.description ?? "Manual adjustment"}
          {adminAuditEntry ? ` - approved by ${adminAuditEntry.actorEmail} (${adminAuditEntry.action})` : ""}
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
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-2">
          <Badge tone="free">Stripe baseline - FREE</Badge>
          <span className="text-micro text-text-subtle">{recoveredPayment.recoveredAt.toLocaleDateString()}</span>
        </div>
        <p className="font-mono text-body font-medium text-text-tertiary">
          {formatMoney(recoveredPayment.amountCents, recoveredPayment.currency)}
        </p>
      </div>
      <p className="text-label text-text-tertiary">
        No Foxhound action preceded this recovery, Stripe's own retry recovered it.{" "}
        <Link to={`/recovery/payments/${recoveredPayment.failedPaymentId}`} className="text-amber-text hover:underline">
          View payment
        </Link>
      </p>
    </ChainRow>
  );
}
