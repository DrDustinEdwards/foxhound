import type { ReactNode } from "react";
import { Link } from "react-router";
import { ArrowUpRight } from "lucide-react";
import { Button } from "capsomer/react/button";
import { Panel } from "capsomer/react/panel";
import { Row, RowList, type RowLinkProps } from "capsomer/react/row-list";
import { Pill } from "capsomer/react/status";
import "capsomer/button.css";
import "capsomer/panel.css";
import "capsomer/row-list.css";
import "capsomer/status.css";

import { DemoGuardedForm } from "~/components/demo-guarded-form";
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
  titleCase,
  type DisputeFeeRow,
  type FeeStatusTone,
  type RecoveryHistoryRow,
  type SubscriptionView,
} from "~/lib/billing/page";
import type { AccountBillingState, CurrencyAmount } from "~/lib/billing/preview.server";
import {
  BILLING_RUN_DAY_OF_MONTH,
  DISPUTE_FEE_CAP_CENTS,
  INTELLIGENCE_PRICE_CENTS,
  RECOVERY_MATURITY_DAYS,
} from "~/lib/constants";
import { PRODUCTS } from "~/lib/marketing/products";
import { formatMoney, formatMoneyShort } from "~/lib/money-format";

// /billing's five sections (J65, row S3), in Recova's order and with Recova's
// content (app/(app)/billing/page.tsx at blob 34e56833, components/
// RecoverySection.tsx 047467ef, DisputeFeesSection.tsx 03d26710,
// SubscriptionsSection.tsx d87f5221, PaymentMethodSection.tsx 0c07cb69). Look is
// Capsomer's (Q10): each section is a Panel, each list a row list, each status a
// Pill, each button Capsomer's Button. Every number is Foxhound's own engine:
// rates from the fee constants, the day from the run's cron fields, amounts
// from the billing preview and the stored invoices. Read-only, apart from the
// one existing action the payment method button posts to.
//
// Recova lines that would be false of Foxhound are rewritten, each named where
// it sits. Text is on the five sizes (RULES.md 5.2): Recova's 0.8125rem is
// label, 0.6875rem is micro, and its 0.9375rem amounts are body.

const INVOICE_DAY = ordinal(BILLING_RUN_DAY_OF_MONTH);

/** Recova's amounts are whole currency units (formatAmountShort), and recovered
 *  amounts stay so. FEES show cents (review F2, a truthfulness fix): rounded to
 *  whole units, a fee under 50 cents read $0 while Stripe charges it. Foxhound
 *  bills per currency, so a total is one line per currency; with none, $0. */
function fmt(cents: number, currency: string, fee: boolean): string {
  return fee ? formatMoney(cents, currency) : formatMoneyShort(cents, currency);
}

function Amounts({ rows, className, fee }: { rows: CurrencyAmount[]; className: string; fee: boolean }) {
  if (rows.length === 0) return <span className={className}>{fmt(0, "usd", fee)}</span>;
  return (
    <span className="flex flex-col items-end">
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
  return <div className="mb-5 rounded-lg border border-border bg-bg px-4 py-4">{children}</div>;
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
    <div className="flex items-baseline justify-between gap-4">
      <span className={`text-label ${muted ? "text-text-tertiary" : "text-text-secondary"}`}>{label}</span>
      <Amounts
        rows={value}
        fee={fee}
        className={`font-mono text-body tabular-nums ${muted ? "text-text-tertiary" : "text-text"}`}
      />
    </div>
  );
}

function StatusPill({ label, tone }: { label: string; tone: FeeStatusTone }) {
  return tone === "neutral" ? <Pill variant="outline">{label}</Pill> : <Pill tone={tone}>{label}</Pill>;
}

const routerLink = ({ href, children, ...rest }: RowLinkProps) => (
  <Link to={href} {...rest}>
    {children}
  </Link>
);

/** Recova's "View invoice" (Stripe's hosted invoice, new tab), or the bare
 *  invoice id in mono when there is no hosted page. */
function InvoiceRef({ url, stripeId }: { url: string | null; stripeId: string | null }) {
  if (url) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="inline-flex min-h-6 items-center gap-0.5 text-micro text-accent-text hover:text-accent-hover"
      >
        View invoice <ArrowUpRight size={12} strokeWidth={1.5} aria-hidden />
      </a>
    );
  }
  if (stripeId) return <span className="font-mono text-micro text-text-tertiary">{stripeId}</span>;
  return null;
}

/** Where Recova's "Next invoice" line would be false: an exempt account is not
 *  invoiced while exempt, and a paused one is not invoiced while paused. Neither
 *  forgives a fee: the billable queries (app/db/billable.ts) have no lower bound
 *  on date, so the first run after an exemption or pause ends bills every fee
 *  that came due meanwhile. The exempt wording is the admin list's own
 *  (admin-merchants-parts.tsx). */
function billingStateNote(state: AccountBillingState): string | null {
  if (state.billingExempt) {
    return "Billing exempt. Foxhound does not invoice this account while it is exempt. Fees that come due while exempt wait, and are billed at the first billing run after the exemption ends.";
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
        // An exempt account is not invoiced while exempt (review F4), so it is not told the day.
        accountBillingState.billingExempt
          ? `${RECOVERY_FEE_PERCENT}% of attributed recoveries`
          : `${RECOVERY_FEE_PERCENT}% of attributed recoveries · Invoiced on the ${INVOICE_DAY}`
      }
    >
      <SummaryBox>
        <div className="flex flex-col gap-2">
          <SummaryRow label="Recovered this month" value={attributedThisMonth} />
          <SummaryRow label={`Estimated fee (${RECOVERY_FEE_PERCENT}%)`} value={estimatedRecoveryFees} muted fee />
        </div>
        <p className="mt-3 text-micro text-text-subtle">{stateNote ?? `Next invoice: ${formatLongDate(nextRunAtMs)}`}</p>
        {accountBillingState.cancelledAt && !stateNote ? (
          <p className="mt-1 text-micro text-text-subtle">
            This account is cancelled. Fees already earned still appear on the next invoice.
          </p>
        ) : null}
        {/* Truthfulness fix: Recova's estimate was this month's recoveries times
            the rate, invoiced next month. Foxhound bills a recovery at the first
            run after it is 30 days old (PRICING.md, maturity-window billing), so
            the estimate is the next run's recovery fees and this line says why
            it is not the rate times the line above, in PRICING's own words. */}
        <p className="mt-1 text-micro text-text-subtle">
          We never bill a recovery until you&apos;ve held the money for {RECOVERY_MATURITY_DAYS} days.
        </p>
      </SummaryBox>

      {rows.length === 0 ? (
        // Truthfulness fix: Recova promised the first invoice "on the 1st of next
        // month", which maturity makes false for a recovery made after the 1st.
        <p className="text-label text-text-subtle">
          No billing history yet. Your first invoice comes on the {INVOICE_DAY} of a month, once a recovery
          Foxhound earned is {RECOVERY_MATURITY_DAYS} days old.
        </p>
      ) : (
        <RowList label="Recovery invoices" gap="sm">
          {rows.map((r) => (
            <Row
              key={r.invoiceId}
              variant="outline"
              title={r.periodLabel}
              href={`/billing/invoices/${r.invoiceId}`}
              renderLink={routerLink}
              detail={`Recovered: ${formatMoneyShort(r.recoveredCents, r.currency)} · Fee: ${formatMoney(r.feeCents, r.currency)}${creditSuffix(r.creditedCents, r.currency)}`}
              actions={
                <span className="flex flex-wrap items-center gap-3">
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
        <p className="mt-1 text-micro text-text-subtle">
          {stateNote ?? `Added to your next monthly invoice on ${formatLongDate(nextRunAtMs)}.`}
        </p>
      </SummaryBox>

      {rows.length === 0 ? (
        <p className="text-label text-text-subtle">No dispute fees yet.</p>
      ) : (
        <RowList label="Dispute fees" gap="sm">
          {rows.map((r) => (
            <Row
              key={r.key}
              variant="outline"
              title={`Dispute won: ${formatMoneyShort(r.disputeAmountCents, r.currency)}`}
              href={`/disputes/${r.disputeId}`}
              renderLink={routerLink}
              detail={`Fee (${r.feeCapped ? "capped" : `${DISPUTE_FEE_PERCENT}%`}): ${formatMoney(r.feeCents, r.currency)}${creditSuffix(r.creditedCents, r.currency)}`}
              actions={
                <span className="flex flex-wrap items-center gap-3">
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

/** Recova's Intelligence offer, shown only to an account without Intelligence.
 *  Recova's "Subscribe to Intelligence" button posts to a checkout Foxhound does
 *  not have, so it is left out and the section says so (RULES.md 2.1, 2.7). */
export function IntelligenceSection() {
  const product = PRODUCTS.intelligence;
  return (
    <Panel title={product.name}>
      <p className="mb-3 text-label text-text-subtle">{product.description}</p>
      <p className="mb-4 font-mono text-label text-accent-text">
        {formatMoneyShort(INTELLIGENCE_PRICE_CENTS, "usd")}/mo, account-wide
      </p>
      <p className="text-label text-text-tertiary">Subscribing from Foxhound is not built yet.</p>
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
 *  past_due (RULES.md 2.7, 3.18). */
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
              renderLink={PRODUCT_HREF[s.product] ? routerLink : plainTitle}
              detail={
                detail ? <span className={detail.warn ? "text-accent-text" : undefined}>{detail.text}</span> : undefined
              }
              actions={
                <StatusPill label={subscriptionStatusLabel(s.status)} tone={subscriptionStatusTone(s.status)} />
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
      <div className="flex flex-col items-start gap-3 md:flex-row md:items-center md:justify-between">
        {card ? (
          <div>
            <p className="text-label text-text">
              {titleCase(card.brand)} ending {card.last4}
            </p>
            <p className="mt-1 text-micro text-text-subtle">
              Expires {String(card.expMonth).padStart(2, "0")}/{card.expYear}
            </p>
          </div>
        ) : (
          <div>
            <p className="text-label text-text-subtle">No payment method on file.</p>
            {/* Truthfulness fix: Recova said "We'll email you a payment link with
                each invoice". Foxhound's invoices are charge_automatically with
                no emailed link (app/lib/billing/stripe-invoice.ts). */}
            <p className="mt-1 text-micro text-text-subtle">
              Add one so Foxhound can charge each monthly invoice automatically on the {INVOICE_DAY}.
            </p>
          </div>
        )}
        <DemoGuardedForm method="post">
          <input type="hidden" name="intent" value="setup_billing" />
          <Button type="submit" variant={card ? "default" : "primary"} pending={busy}>
            {card ? "Update payment method" : "Add payment method"}
          </Button>
        </DemoGuardedForm>
      </div>
    </Panel>
  );
}
