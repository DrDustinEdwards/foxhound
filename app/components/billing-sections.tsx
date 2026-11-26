import { capitalize } from "@drdustinedwards/site-helpers/text";
import type { ReactNode } from "react";
import { routerRenderLink, AwayLink } from "capsomer/react/link";
import { Button } from "capsomer/react/button";
import { Panel } from "capsomer/react/panel";
import { Row, RowList } from "capsomer/react/row-list";
import { Pill } from "capsomer/react/status";
import "capsomer/button.css";
import "capsomer/panel.css";
import "capsomer/row-list.css";
import "capsomer/status.css";
import "capsomer/link.css";

import { DemoForm } from "~/lib/demo/use-demo-guard";
import type { CardSummary } from "~/lib/billing/platform-customer";
import {
  DISPUTE_FEE_PERCENT,
  RECOVERY_FEE_PERCENT,
  formatInvoiceDate,
  ordinal,
  type DisputeFeeRow,
  type FeeStatusTone,
  type RecoveryHistoryRow,
} from "~/lib/billing/page";
import type { AccountBillingState } from "~/lib/billing/preview.server";
import type { CurrencyAmount } from "~/lib/money/totals";
import {
  BILLING_RUN_DAY_OF_MONTH,
  DISPUTE_FEE_CAP_CENTS,
  RECOVERY_MATURITY_DAYS,
} from "~/lib/constants";
import { formatMoney, formatMoneyShort } from "@dustinedwards/site-runtime/money";

// /billing's five sections: each a Panel, each list a row list, each status a Pill. Every number is Foxhound's own engine: rates from the fee constants, the day from the run's cron fields, amounts from the billing preview and the stored invoices. Read-only, apart from the one existing action the payment method button posts to. Text is on the five sizes (0.8125rem is label, 0.6875rem micro, 0.9375rem body).

const INVOICE_DAY = ordinal(BILLING_RUN_DAY_OF_MONTH);

/** Recovered amounts are whole currency units. FEES show cents: rounded to whole units, a fee under 50 cents read $0 while Stripe charges it. Foxhound bills per currency, so a total is one line per currency; with none, $0. */
function fmt(cents: number, currency: string, fee: boolean): string {
  return fee ? formatMoney(cents, currency) : formatMoneyShort(cents, currency);
}

function Amounts({
  rows,
  className,
  fee,
}: {
  rows: CurrencyAmount[];
  className: string;
  fee: boolean;
}) {
  if (rows.length === 0) return <span className={className}>{fmt(0, "usd", fee)}</span>;
  return (
    <span className="fh-billing-figure">
      {rows.map((r) => (
        <span key={r.currency} className={className}>
          {fmt(r.cents, r.currency, fee)}
        </span>
      ))}
    </span>
  );
}

/** A credit note issued since against the fee (PRICING.md rev 5), shown on the row so a credited fee never reads as simply charged. */
function creditSuffix(creditedCents: number, currency: string): string {
  return creditedCents > 0 ? ` · Credited: ${formatMoney(creditedCents, currency)}` : "";
}

/** An inset summary box (bordered, rounded) inside a section. Capsomer has no key-value block for a panel body; this composes one from Foxhound's tokens. */
function SummaryBox({ children }: { children: ReactNode }) {
  return <div className="fh-billing-box">{children}</div>;
}

function SummaryRow({
  label,
  value,
  muted = false,
  fee = false,
}: {
  label: string;
  value: CurrencyAmount[];
  muted?: boolean;
  fee?: boolean;
}) {
  return (
    <div className="fh-billing-line">
      <span className={`fh-small ${muted ? "fh-quiet" : "fh-soft"}`}>{label}</span>
      <Amounts
        rows={value}
        fee={fee}
        className={`fh-mono fh-body cap-num ${muted ? "fh-quiet" : "fh-text"}`}
      />
    </div>
  );
}

function StatusPill({ label, tone }: { label: string; tone: FeeStatusTone }) {
  return tone === "neutral" ? (
    <Pill variant="outline">{label}</Pill>
  ) : (
    <Pill tone={tone}>{label}</Pill>
  );
}

/** "View invoice" (Stripe's hosted invoice, new tab), or the bare invoice id in mono when there is no hosted page. */
function InvoiceRef({ url, stripeId }: { url: string | null; stripeId: string | null }) {
  if (url) {
    return (
      <AwayLink href={url} newTab className="fh-invoice-link fh-tiny">
        View invoice
      </AwayLink>
    );
  }
  if (stripeId) return <span className="fh-mono fh-tiny fh-quiet">{stripeId}</span>;
  return null;
}

/** A fee row's status pill and its invoice link. */
function FeeRowActions({
  row,
}: {
  row: Pick<RecoveryHistoryRow, "statusLabel" | "statusTone" | "invoiceUrl" | "stripeInvoiceId">;
}) {
  return (
    <span className="cap-cluster" data-gap="4">
      <StatusPill label={row.statusLabel} tone={row.statusTone} />
      <InvoiceRef url={row.invoiceUrl} stripeId={row.stripeInvoiceId} />
    </span>
  );
}

/** Where a "Next invoice" line would be false: an exempt account is never invoiced, and a paused one is not invoiced while paused. */
function billingStateNote(state: AccountBillingState): string | null {
  if (state.billingExempt) {
    return "Billing exempt. Foxhound does not invoice this account, so no fee is building up.";
  }
  if (state.processingPaused) {
    return "Processing is paused. Nothing is invoiced while it stays paused. A pause defers a fee, it does not cancel one.";
  }
  return null;
}

export function RecoverySection({
  attributedThisMonth,
  estimatedRecoveryFees,
  nextRunAtMs,
  accountBillingState,
  rows,
}: {
  attributedThisMonth: CurrencyAmount[];
  estimatedRecoveryFees: CurrencyAmount[];
  nextRunAtMs: number;
  accountBillingState: AccountBillingState;
  rows: RecoveryHistoryRow[];
}) {
  const stateNote = billingStateNote(accountBillingState);
  return (
    <Panel title="Recovery" meta={`${RECOVERY_FEE_PERCENT}% of attributed recoveries`}>
      <SummaryBox>
        <div className="cap-stack" data-gap="3">
          <SummaryRow label="Recovered this month" value={attributedThisMonth} />
          <SummaryRow
            label={`Estimated fee (${RECOVERY_FEE_PERCENT}%)`}
            value={estimatedRecoveryFees}
            muted
            fee
          />
        </div>
        <p className="fh-billing-note fh-tiny fh-quiet">
          {stateNote ?? `Next invoice: ${formatInvoiceDate(nextRunAtMs)}`}
        </p>
        {accountBillingState.cancelledAt && !stateNote ? (
          <p className="fh-billing-fine fh-tiny fh-quiet">
            This account is canceled. Fees already earned still appear on the next invoice.
          </p>
        ) : null}
        <p className="fh-billing-fine fh-tiny fh-quiet">
          We never bill a recovery until you&apos;ve held the money for {RECOVERY_MATURITY_DAYS}{" "}
          days.
        </p>
      </SummaryBox>

      {rows.length === 0 ? (
        // The first invoice is not promised "on the 1st of next month": maturity makes that false for a recovery made after the 1st.
        <p className="fh-small fh-quiet">
          No billing history yet. Your first invoice comes on the {INVOICE_DAY} of a month, once a
          recovery Foxhound earned is {RECOVERY_MATURITY_DAYS} days old.
        </p>
      ) : (
        <RowList label="Recovery invoices" gap="sm">
          {rows.map((r) => (
            <Row
              key={r.invoiceId}
              variant="outline"
              title={r.periodLabel}
              href={`/billing/invoices/${r.invoiceId}`}
              renderLink={routerRenderLink}
              detail={`Recovered: ${formatMoneyShort(r.recoveredCents, r.currency)} · Fee: ${formatMoney(r.feeCents, r.currency)}${creditSuffix(r.creditedCents, r.currency)}`}
              actions={<FeeRowActions row={r} />}
            />
          ))}
        </RowList>
      )}
    </Panel>
  );
}

export function DisputeFeesSection({
  estimatedDisputeFees,
  nextRunAtMs,
  accountBillingState,
  rows,
}: {
  estimatedDisputeFees: CurrencyAmount[];
  nextRunAtMs: number;
  accountBillingState: AccountBillingState;
  rows: DisputeFeeRow[];
}) {
  const stateNote = billingStateNote(accountBillingState);
  // Disputes needs no enabling in Foxhound (every account has it, app/lib/nav/manifest.ts), so the active branch is always the one shown.
  return (
    <Panel
      title="Dispute Fees"
      meta={`${DISPUTE_FEE_PERCENT}% of disputes won, capped at ${formatMoneyShort(DISPUTE_FEE_CAP_CENTS, "usd")} each`}
      footer={
        // PRICING.md: "$500, converted at Stripe's rate on the day the dispute resolves".
        <p className="fh-billing-fine fh-tiny fh-quiet">
          Converted at Stripe&apos;s rate on the day the dispute resolves. Disputes won by Stripe
          Smart Disputes or submitted by you are not charged.
        </p>
      }
    >
      <SummaryBox>
        <SummaryRow label="Pending fees this month" value={estimatedDisputeFees} fee />
        <p className="fh-billing-fine fh-tiny fh-quiet">
          {stateNote ?? `Added to your next monthly invoice on ${formatInvoiceDate(nextRunAtMs)}.`}
        </p>
      </SummaryBox>

      {rows.length === 0 ? (
        <p className="fh-small fh-quiet">No dispute fees yet.</p>
      ) : (
        <RowList label="Dispute fees" gap="sm">
          {rows.map((r) => (
            <Row
              key={r.key}
              variant="outline"
              title={`Dispute won: ${formatMoneyShort(r.disputeAmountCents, r.currency)}`}
              href={`/disputes/${r.disputeId}`}
              renderLink={routerRenderLink}
              detail={`Fee (${r.feeCapped ? "capped" : `${DISPUTE_FEE_PERCENT}%`}): ${formatMoney(r.feeCents, r.currency)}${creditSuffix(r.creditedCents, r.currency)}`}
              actions={<FeeRowActions row={r} />}
            />
          ))}
        </RowList>
      )}
    </Panel>
  );
}

export function PaymentMethodSection({ card, busy }: { card: CardSummary | null; busy: boolean }) {
  return (
    <Panel title="Payment method">
      <div className="fh-setting-row">
        {card ? (
          <div>
            <p className="fh-small fh-text">
              {capitalize(card.brand)} ending {card.last4}
            </p>
            <p className="fh-billing-fine fh-tiny fh-quiet">
              Expires {String(card.expMonth).padStart(2, "0")}/{card.expYear}
            </p>
          </div>
        ) : (
          <div>
            <p className="fh-small fh-quiet">No payment method on file.</p>
            {/* Truthfulness fix: Recova said "We'll email you a payment link with
                each invoice". Foxhound's invoices are charge_automatically with
                no emailed link (app/lib/billing/stripe-invoice.ts). */}
            <p className="fh-billing-fine fh-tiny fh-quiet">
              Add one so Foxhound can charge each monthly invoice automatically on the {INVOICE_DAY}
              .
            </p>
          </div>
        )}
        <DemoForm method="post">
          <input type="hidden" name="intent" value="setup_billing" />
          <Button type="submit" variant={card ? "default" : "primary"} pending={busy}>
            {card ? "Update payment method" : "Add payment method"}
          </Button>
        </DemoForm>
      </div>
    </Panel>
  );
}
