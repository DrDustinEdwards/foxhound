import { LedgerLineItemRow } from "~/components/billing-ledger-row";
import { Badge } from "~/components/badge";
import { getDb } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { authContext } from "~/lib/auth/context";
import { BILLING_INVOICE_STATUS_LABELS, billingInvoiceStatusTone } from "~/lib/billing/labels";
import { getBillingInvoiceDetail } from "~/lib/billing/queries.server";
import { formatMoney } from "~/lib/money-format";

import type { Route } from "./+types/invoice";
import { NOINDEX } from "~/lib/seo/meta";

export function meta() {
  return [{ title: "Invoice - Foxhound" }, NOINDEX];
}

export async function loader({ context, params }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const db = getDb(env);
  const detail = await getBillingInvoiceDetail(db, auth.membership.accountId, params.id);
  if (!detail) throw new Response("Not Found", { status: 404 });
  return detail;
}

export default function BillingInvoice({ loaderData }: Route.ComponentProps) {
  const { invoice, lineItems } = loaderData;

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <div className="rounded-lg border border-border bg-surface p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-title font-medium text-text">
              {invoice.periodStart.toLocaleDateString()} - {invoice.periodEnd.toLocaleDateString()}
            </h1>
            <p className="mt-1 text-label text-text-tertiary">{invoice.currency.toUpperCase()}</p>
          </div>
          <p className="font-mono text-title text-text">{formatMoney(invoice.totalCents, invoice.currency)}</p>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Badge tone={billingInvoiceStatusTone(invoice.status)}>
            {BILLING_INVOICE_STATUS_LABELS[invoice.status] ?? invoice.status}
          </Badge>
          {invoice.stripeInvoiceUrl ? (
            <a href={invoice.stripeInvoiceUrl} target="_blank" rel="noreferrer" className="text-label text-brand-text hover:underline">
              View Stripe invoice
            </a>
          ) : null}
        </div>
      </div>

      <div className="mt-6 rounded-lg border border-border bg-surface p-4">
        <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Line items</p>
        {lineItems.length === 0 ? (
          <p className="mt-2 text-label text-text-tertiary">No line items on this invoice.</p>
        ) : (
          <ol className="mt-3 flex flex-col">
            {lineItems.map((entry) => (
              <LedgerLineItemRow key={entry.lineItem.id} entry={entry} />
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
