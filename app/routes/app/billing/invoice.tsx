import { Pill } from "capsomer/react/status";
import "capsomer/status.css";
import { formatDate } from "capsomer/behavior/time";
import { LedgerLineItemRow } from "~/components/billing-ledger-row";
import { BADGE_PILL } from "~/lib/recovery/labels";
import { getDb } from "~/db";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import { authContext } from "~/lib/auth/context";
import { BILLING_INVOICE_STATUS_LABELS, billingInvoiceStatusTone } from "~/lib/billing/labels";
import { getBillingInvoiceDetail } from "~/lib/billing/queries.server";
import { formatMoney } from "@dustinedwards/site-runtime/money";

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
    <div className="fh-invoice">
      <div className="fh-box">
        <div className="fh-split">
          <div>
            <h1 className="fh-title fh-medium fh-text">
              {formatDate(invoice.periodStart, { style: "medium" }) ?? ""} -{" "}
              {formatDate(invoice.periodEnd, { style: "medium" }) ?? ""}
            </h1>
            <p className="fh-invoice-currency fh-small fh-quiet">
              {invoice.currency.toUpperCase()}
            </p>
          </div>
          <p className="fh-mono fh-title fh-text">
            {formatMoney(invoice.totalCents, invoice.currency)}
          </p>
        </div>
        <div className="fh-invoice-actions">
          <Pill {...BADGE_PILL[billingInvoiceStatusTone(invoice.status)]}>
            {BILLING_INVOICE_STATUS_LABELS[invoice.status] ?? invoice.status}
          </Pill>
          {invoice.stripeInvoiceUrl ? (
            <a
              href={invoice.stripeInvoiceUrl}
              target="_blank"
              rel="noreferrer"
              className="fh-small"
            >
              View Stripe invoice
              <span className="cap-sr-only"> (opens in a new tab)</span>
            </a>
          ) : null}
        </div>
      </div>

      <div className="fh-box fh-invoice-lines">
        <p className="fh-mono fh-tiny fh-quiet fh-caps">Line items</p>
        {lineItems.length === 0 ? (
          <p className="fh-invoice-empty fh-small fh-quiet">No line items on this invoice.</p>
        ) : (
          <ol className="fh-invoice-list">
            {lineItems.map((entry) => (
              <LedgerLineItemRow key={entry.lineItem.id} entry={entry} />
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
