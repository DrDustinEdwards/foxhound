import type { BillingPreview, CurrencyAmount } from "~/lib/billing/preview.server";
import { formatMoney } from "~/lib/money-format";

// The forward-looking half of /billing: what the next run is on course to
// invoice, shown before the invoice exists. Read-only, and it renders exactly
// what app/lib/billing/preview.server.ts computed from the billing engine's own
// predicates; it does no money math of its own.
//
// The states matter more than the layout here. An empty estimate has three
// completely different meanings (nothing is owed / this account is never billed
// / this account is paused) and only the first one is "nothing is due". The
// other two are rendered as themselves, because a merchant reading "nothing is
// due" on an exempt account has been told something false and has no way to
// check it.
//
// Copy rule (PRICING.md): the merchant's own computed amounts are fine to show,
// the RATE is not. No percentage, no rate number, no pricing language.

function AmountRows({ rows }: { rows: CurrencyAmount[] }) {
  return (
    <>
      {rows.map((row) => (
        <p key={row.currency} className="font-mono text-body text-text">
          {formatMoney(row.cents, row.currency)}
        </p>
      ))}
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-micro uppercase tracking-wide text-text-tertiary">{label}</p>
      <div className="mt-1">{children}</div>
    </div>
  );
}

/** The run instant formatted in UTC. The cron fires at 04:00 UTC, so rendering
 *  it in a viewer's local zone would show the previous day for anyone west of
 *  London and disagree with the invoice period. */
function formatRunDate(nextRunAtMs: number): string {
  return new Date(nextRunAtMs).toLocaleDateString("en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-6 rounded-lg border border-border bg-surface p-4">
      <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Next invoice</p>
      {children}
    </div>
  );
}

export function BillingEstimateCard({ preview }: { preview: BillingPreview }) {
  const { recoveredThisMonth, nextRunAtMs, estimatedInvoice, accountBillingState } = preview;
  const { billingExempt, processingPaused, cancelledAt } = accountBillingState;

  // Exempt first: it is the more permanent of the two, and an account can carry
  // both flags at once.
  if (billingExempt) {
    return (
      <Card>
        <p className="mt-2 text-label text-text-tertiary">
          Billing exempt. Foxhound does not invoice this account, so no fee is building up.
        </p>
      </Card>
    );
  }

  if (processingPaused) {
    return (
      <Card>
        <p className="mt-2 text-label text-text-tertiary">
          Processing is paused. Nothing is invoiced while it stays paused. A pause defers a fee,
          it does not cancel one.
        </p>
      </Card>
    );
  }

  const hasEstimate = estimatedInvoice.length > 0;

  return (
    <Card>
      {cancelledAt ? (
        <p className="mt-2 text-label text-text-tertiary">
          This account is cancelled. Fees already earned still appear on the next invoice.
        </p>
      ) : null}

      <div className="mt-3 flex flex-col gap-4 sm:flex-row sm:gap-8">
        <Field label="Recovered this month">
          {recoveredThisMonth.length > 0 ? (
            <AmountRows rows={recoveredThisMonth} />
          ) : (
            <p className="text-label text-text-tertiary">None yet</p>
          )}
        </Field>

        <Field label="Estimated fee">
          {hasEstimate ? (
            <AmountRows rows={estimatedInvoice} />
          ) : (
            <p className="text-label text-text-tertiary">Nothing is due</p>
          )}
        </Field>

        <Field label="Invoices on">
          <p className="font-mono text-body text-text">{formatRunDate(nextRunAtMs)}</p>
        </Field>
      </div>

      {hasEstimate ? (
        <p className="mt-3 text-label text-text-tertiary">
          Estimate. Refunds or disputes before the run reduce it; the invoice is the record.
        </p>
      ) : null}
    </Card>
  );
}
