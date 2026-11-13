import { capitalize } from "@drdustinedwards/site-helpers/text";
import type { ReactNode } from "react";
import { routerRenderLink } from "capsomer/react/link";
import { Icon } from "capsomer/react/icons";
import { Button } from "capsomer/react/button";
import { Panel } from "capsomer/react/panel";
import { Row, RowList, type RowLinkProps } from "capsomer/react/row-list";
import { Pill } from "capsomer/react/status";
import "capsomer/button.css";
import "capsomer/panel.css";
import "capsomer/row-list.css";
import "capsomer/status.css";

import { DemoForm } from "~/lib/demo/use-demo-guard";
import type { CardSummary } from "~/lib/billing/platform-customer";
import {
  DISPUTE_FEE_PERCENT,
  RECOVERY_FEE_PERCENT,
  formatLongDate,
  ordinal,
  productDisplayName,
  subscriptionDetail,
  subscriptionStatusLabel,
  subscriptionStatusTone,
  type DisputeFeeRow,
  type FeeStatusTone,
  type RecoveryHistoryRow,
  type SubscriptionView,
} from "~/lib/billing/page";
import type { AccountBillingState } from "~/lib/billing/preview.server";
import type { CurrencyAmount } from "~/lib/money/totals";
import {
  BILLING_RUN_DAY_OF_MONTH,
  DISPUTE_FEE_CAP_CENTS,
  RECOVERY_MATURITY_DAYS,
} from "~/lib/constants";
import { formatMoney, formatMoneyShort } from "@dustinedwards/site-runtime/money";

// /billing's five sections, in Recova's order and with Recova's
// content (app/(app)/billing/page.tsx at blob 34e56833, components/
// RecoverySection.tsx 047467ef, DisputeFeesSection.tsx 03d26710,
// SubscriptionsSection.tsx d87f5221, PaymentMethodSection.tsx 0c07cb69). Look is
// Capsomer's: each section is a Panel, each list a row list, each status a
// Pill, each button Capsomer's Button. Every number is Foxhound's own engine:
// rates from the fee constants, the day from the run's cron fields, amounts
// from the billing preview and the stored invoices. Read-only, apart from the
// one existing action the payment method button posts to.
//
// Recova lines that would be false of Foxhound are rewritten, each named where
// it sits. Text is on the five sizes: Recova's 0.8125rem is
// label, 0.6875rem is micro, and its 0.9375rem amounts are body.

const INVOICE_DAY = ordinal(BILLING_RUN_DAY_OF_MONTH);

/** Recova's amounts are whole currency units (formatAmountShort), and recovered
 *  amounts stay so. FEES show cents (review F2, a truthfulness fix): rounded to
 *  whole units, a fee under 50 cents read $0 while Stripe charges it. Foxhound
 *  bills per currency, so a total is one line per currency; with none, $0. */
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

/** A credit note issued since against the fee (PRICING.md rev 5), shown on the
 *  row so a credited fee never reads as simply charged (review F1). */
function creditSuffix(creditedCents: number, currency: string): string {
  return creditedCents > 0 ? ` · Credited: ${formatMoney(creditedCents, currency)}` : "";
}

/** Recova's inset summary box (bg-bg, bordered, rounded) inside a section.
 *  Capsomer has no key-value block for a panel body; this composes one from
 *  Foxhound's tokens and is listed in the PR as a Capsomer gap. */
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
      <span className={`fh-small ${muted ? "text-text-tertiary" : "text-text-secondary"}`}>
        {label}
      </span>
      <Amounts
        rows={value}
        fee={fee}
        className={`fh-mono fh-body cap-num ${muted ? "text-text-tertiary" : "text-text"}`}
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

/** Recova's "View invoice" (Stripe's hosted invoice, new tab), or the bare
 *  invoice id in mono when there is no hosted page. */
function InvoiceRef({ url, stripeId }: { url: string | null; stripeId: string | null }) {
  if (url) {
    return (
      <a href={url} target="_blank" rel="noreferrer" className="fh-invoice-link fh-tiny">
        View invoice <Icon name="arrow-up-right" className="fh-icon-12 fh-icon-fine" />
        <span className="cap-sr-only"> (opens in a new tab)</span>
      </a>
    );
  }
  if (stripeId) return <span className="fh-mono fh-tiny fh-quiet">{stripeId}</span>;
  return null;
}

/** Where Recova's "Next invoice" line would be false: an exempt account is never
 *  invoiced, and a paused one is not invoiced while paused. */
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
    <Panel
      title="Recovery"
      description={
        // An exempt account is never invoiced (review F4), so it is not told the day.
        accountBillingState.billingExempt
          ? `${RECOVERY_FEE_PERCENT}% of attributed recoveries`
          : `${RECOVERY_FEE_PERCENT}% of attributed recoveries · Invoiced on the ${INVOICE_DAY}`
      }
    >
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
        <p className="fh-billing-note fh-tiny fh-faint">
          {stateNote ?? `Next invoice: ${formatLongDate(nextRunAtMs)}`}
        </p>
        {accountBillingState.cancelledAt && !stateNote ? (
          <p className="fh-billing-fine fh-tiny fh-faint">
            This account is canceled. Fees already earned still appear on the next invoice.
          </p>
        ) : null}
        {/* Truthfulness fix: Recova's estimate was this month's recoveries times
            the rate, invoiced next month. Foxhound bills a recovery at the first
            run after it is 30 days old (PRICING.md, maturity-window billing), so
            the estimate is the next run's recovery fees and this line says why
            it is not the rate times the line above, in PRICING's own words. */}
        <p className="fh-billing-fine fh-tiny fh-faint">
          We never bill a recovery until you&apos;ve held the money for {RECOVERY_MATURITY_DAYS}{" "}
          days.
        </p>
      </SummaryBox>

      {rows.length === 0 ? (
        // Truthfulness fix: Recova promised the first invoice "on the 1st of next
        // month", which maturity makes false for a recovery made after the 1st.
        <p className="fh-small fh-faint">
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
              actions={
                <span className="cap-cluster" data-gap="4">
                  <StatusPill label={r.statusLabel} tone={r.statusTone} />
                  <InvoiceRef url={r.invoiceUrl} stripeId={r.stripeInvoiceId} />
                </span>
              }
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
  const cap = formatMoneyShort(DISPUTE_FEE_CAP_CENTS, "usd");
  // Disputes needs no enabling in Foxhound (every account has it, app/lib/nav/
  // manifest.ts), so Recova's disputesActive branch is always the one shown.
  return (
    <Panel
      title="Dispute Fees"
      description={
        // Truthfulness fix: Recova's sentence left out the cap, which Foxhound's
        // engine applies (PRICING.md: "$500, converted at Stripe's rate on the
        // day the dispute resolves").
        `Foxhound charges ${DISPUTE_FEE_PERCENT}% of disputes we win on your behalf, capped at ${cap} per dispute, converted at Stripe's rate on the day the dispute resolves. Disputes won by Stripe Smart Disputes or submitted by you are not charged.`
      }
    >
      <SummaryBox>
        <SummaryRow label="Pending fees this month" value={estimatedDisputeFees} fee />
        <p className="fh-billing-fine fh-tiny fh-faint">
          {stateNote ?? `Added to your next monthly invoice on ${formatLongDate(nextRunAtMs)}.`}
        </p>
      </SummaryBox>

      {rows.length === 0 ? (
        <p className="fh-small fh-faint">No dispute fees yet.</p>
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
              actions={
                <span className="cap-cluster" data-gap="4">
                  <StatusPill label={r.statusLabel} tone={r.statusTone} />
                  <InvoiceRef url={r.invoiceUrl} stripeId={r.stripeInvoiceId} />
                </span>
              }
            />
          ))}
        </RowList>
      )}
    </Panel>
  );
}

/** Each product's own page. A product with none gets a plain title, never a
 *  link back to this section (review F5). */
const PRODUCT_HREF: Record<string, string> = {
  intelligence: "/intelligence/dashboard",
  disputes: "/disputes/dashboard",
  recovery: "/recovery/dashboard",
};

/** The row list needs a link or a button title; with nowhere to go, the title is
 *  plain text, which is neither (Capsomer gap 1 in the J65 pull request). */
const plainTitle = ({ children }: RowLinkProps) => <span>{children}</span>;

/** Recova's Subscriptions section; nothing at all when there are none. Recova's
 *  Cancel and Keep subscription buttons, and its past-due banner, are left out:
 *  Foxhound has no merchant cancel or reactivate writer, and nothing writes
 *  past_due. */
export function SubscriptionsSection({ subscriptions }: { subscriptions: SubscriptionView[] }) {
  if (subscriptions.length === 0) return null;
  return (
    <Panel title="Subscriptions" id="subscriptions">
      <RowList label="Subscriptions" gap="sm">
        {subscriptions.map((s) => {
          const detail = subscriptionDetail(s);
          return (
            <Row
              key={s.id}
              variant="outline"
              title={productDisplayName(s.product)}
              href={PRODUCT_HREF[s.product] ?? ""}
              renderLink={PRODUCT_HREF[s.product] ? routerRenderLink : plainTitle}
              detail={
                detail ? (
                  <span className={detail.warn ? "fh-accent" : undefined}>{detail.text}</span>
                ) : undefined
              }
              actions={
                <StatusPill
                  label={subscriptionStatusLabel(s.status)}
                  tone={subscriptionStatusTone(s.status)}
                />
              }
            />
          );
        })}
      </RowList>
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
            <p className="fh-billing-fine fh-tiny fh-faint">
              Expires {String(card.expMonth).padStart(2, "0")}/{card.expYear}
            </p>
          </div>
        ) : (
          <div>
            <p className="fh-small fh-faint">No payment method on file.</p>
            {/* Truthfulness fix: Recova said "We'll email you a payment link with
                each invoice". Foxhound's invoices are charge_automatically with
                no emailed link (app/lib/billing/stripe-invoice.ts). */}
            <p className="fh-billing-fine fh-tiny fh-faint">
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
