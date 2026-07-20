import { Badge } from "~/components/badge";
import { AdminNav } from "~/components/admin-nav";
import { getDb } from "~/db";
import { getMerchantDetail } from "~/lib/admin/merchants.server";
import { BILLING_INVOICE_STATUS_LABELS, billingInvoiceStatusTone } from "~/lib/billing/labels";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { formatMoney } from "~/lib/money-format";

import type { Route } from "./+types/detail";

export function meta() {
  return [{ title: "Merchant detail - Foxhound Admin" }];
}

export async function loader({ context, params }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const db = getDb(env);
  const detail = await getMerchantDetail(db, params.id);
  if (!detail) throw new Response("Not Found", { status: 404 });
  return detail;
}

export default function AdminMerchantDetail({ loaderData }: Route.ComponentProps) {
  const { account, connections, products, subscriptions, recoveryActivity, disputeActivity, recentInvoices } =
    loaderData;

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <h1 className="text-title font-medium text-text">{account.name ?? account.id}</h1>
      <AdminNav />

      <section className="rounded-lg border border-border bg-surface p-4">
        <div className="flex flex-wrap items-center gap-2">
          {account.billingExempt ? <Badge tone="neutral">Billing exempt</Badge> : null}
          {account.processingPaused ? <Badge tone="failure">Processing paused</Badge> : null}
          {!account.billingExempt && !account.processingPaused ? <Badge tone="success">Normal</Badge> : null}
        </div>
        <p className="mt-2 text-label text-text-tertiary">
          Account id <span className="font-mono text-text">{account.id}</span>
        </p>
        <p className="text-label text-text-tertiary">
          Created {account.createdAt ? account.createdAt.toLocaleString() : "unknown"}
        </p>
        <p className="text-label text-text-tertiary">
          Platform Stripe customer:{" "}
          <span className="font-mono text-text">{account.platformStripeCustomerId ?? "not set up"}</span>
        </p>
        <p className="mt-3 text-label text-text-tertiary">
          Billing-status changes (exempt, pause, cancel/disconnect) are operator actions gated to a
          mandatory-review pass; not available from this read-only detail view yet.
        </p>
      </section>

      <section className="mt-6 rounded-lg border border-border bg-surface p-4">
        <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Stripe connections</p>
        {connections.length === 0 ? (
          <p className="mt-2 text-label text-text-tertiary">No Stripe connections.</p>
        ) : (
          <div className="mt-3 flex flex-col gap-2">
            {connections.map((c) => (
              <div key={c.id} className="flex items-center justify-between border-b border-border-sub py-2 last:border-0">
                <div>
                  <p className="text-text">{c.name ?? c.stripeUserId}</p>
                  <p className="font-mono text-micro text-text-subtle">{c.stripeUserId}</p>
                </div>
                <div className="flex items-center gap-2">
                  {c.isPrimary ? <Badge tone="neutral">Primary</Badge> : null}
                  <Badge tone={c.disconnectedAt ? "failure" : "success"}>
                    {c.disconnectedAt ? "Disconnected" : "Active"}
                  </Badge>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="rounded-lg border border-border bg-surface p-4">
          <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Products</p>
          {products.length === 0 ? (
            <p className="mt-2 text-label text-text-tertiary">None.</p>
          ) : (
            <ul className="mt-2 flex flex-col gap-1.5">
              {products.map((p) => (
                <li key={p.id} className="flex items-center justify-between text-label">
                  <span className="text-text">{p.product}</span>
                  <Badge tone={p.status === "active" ? "success" : "neutral"}>{p.status}</Badge>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-lg border border-border bg-surface p-4">
          <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Subscriptions</p>
          {subscriptions.length === 0 ? (
            <p className="mt-2 text-label text-text-tertiary">None.</p>
          ) : (
            <ul className="mt-2 flex flex-col gap-1.5">
              {subscriptions.map((s) => (
                <li key={s.id} className="flex items-center justify-between text-label">
                  <span className="text-text">
                    {s.product}
                    {s.adminGranted ? <span className="ml-1.5 text-text-subtle">(admin-granted)</span> : null}
                  </span>
                  <Badge tone={s.status === "active" ? "success" : "neutral"}>{s.status}</Badge>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="rounded-lg border border-border bg-surface p-4">
          <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Recovery activity</p>
          <p className="mt-2 text-label text-text-tertiary">
            <span className="font-mono text-text">{recoveryActivity.activeCount}</span> active,{" "}
            <span className="font-mono text-text">{recoveryActivity.recoveredCount}</span> recovered
          </p>
        </div>
        <div className="rounded-lg border border-border bg-surface p-4">
          <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Dispute activity</p>
          <p className="mt-2 text-label text-text-tertiary">
            <span className="font-mono text-text">{disputeActivity.openCount}</span> open,{" "}
            <span className="font-mono text-text">{disputeActivity.resolvedWonCount}</span> won,{" "}
            <span className="font-mono text-text">{disputeActivity.resolvedLostCount}</span> lost
          </p>
        </div>
      </section>

      <section className="mt-6 rounded-lg border border-border bg-surface p-4">
        <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Recent invoices</p>
        {recentInvoices.length === 0 ? (
          <p className="mt-2 text-label text-text-tertiary">No invoices yet.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-label">
              <thead>
                <tr className="border-b border-border text-micro uppercase tracking-wide text-text-tertiary">
                  <th className="py-2 pr-4 font-normal">Period</th>
                  <th className="py-2 pr-4 font-normal">Total</th>
                  <th className="py-2 font-normal">Status</th>
                </tr>
              </thead>
              <tbody>
                {recentInvoices.map((inv) => (
                  <tr key={inv.id} className="border-b border-border-sub last:border-0">
                    <td className="py-2 pr-4 text-text-tertiary">
                      {inv.periodStart.toLocaleDateString()} - {inv.periodEnd.toLocaleDateString()}
                    </td>
                    <td className="py-2 pr-4 font-mono text-text">{formatMoney(inv.totalCents, inv.currency)}</td>
                    <td className="py-2">
                      <Badge tone={billingInvoiceStatusTone(inv.status)}>
                        {BILLING_INVOICE_STATUS_LABELS[inv.status] ?? inv.status}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
