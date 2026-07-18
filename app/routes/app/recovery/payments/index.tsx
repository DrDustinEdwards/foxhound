import { Link } from "react-router";

import { Badge } from "~/components/badge";
import { getDb } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { authContext } from "~/lib/auth/context";
import { formatMoney } from "~/lib/money-format";
import { DECLINE_CATEGORY_LABELS, FAILED_PAYMENT_STATUS_LABELS, failedPaymentStatusTone } from "~/lib/recovery/labels";
import { listFailedPayments } from "~/lib/recovery/queries.server";

import type { Route } from "./+types/index";

export function meta() {
  return [{ title: "Payments - Foxhound" }];
}

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const db = getDb(env);
  const payments = await listFailedPayments(db, auth.membership.accountId);
  return { payments };
}

export default function RecoveryPayments({ loaderData }: Route.ComponentProps) {
  const { payments } = loaderData;

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <h1 className="text-title font-medium text-text">Payments</h1>

      {payments.length === 0 ? (
        <p className="mt-6 rounded-lg border border-dashed border-border p-6 text-body text-text-tertiary">
          No failed payments yet. Foxhound will list every failed payment it detects here.
        </p>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-left text-label">
            <thead>
              <tr className="border-b border-border text-micro uppercase tracking-wide text-text-tertiary">
                <th className="px-4 py-3 font-normal">Customer</th>
                <th className="px-4 py-3 font-normal">Amount</th>
                <th className="px-4 py-3 font-normal">Decline</th>
                <th className="px-4 py-3 font-normal">Status</th>
                <th className="px-4 py-3 font-normal">Detected</th>
              </tr>
            </thead>
            <tbody>
              {payments.map((p) => (
                <tr key={p.id} className="border-b border-border-sub last:border-0">
                  <td className="px-4 py-3">
                    <Link to={`/recovery/payments/${p.id}`} className="text-text hover:text-amber">
                      {p.customerName ?? p.customerEmail}
                    </Link>
                  </td>
                  <td className="px-4 py-3 font-mono text-text">{formatMoney(p.amountCents, p.currency)}</td>
                  <td className="px-4 py-3 text-text-tertiary">
                    {DECLINE_CATEGORY_LABELS[p.declineCategory as keyof typeof DECLINE_CATEGORY_LABELS] ??
                      p.declineCategory}
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone={failedPaymentStatusTone(p.status)}>
                      {FAILED_PAYMENT_STATUS_LABELS[p.status] ?? p.status}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-text-tertiary">{p.detectedAt.toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
