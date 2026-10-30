import { Badge } from "~/components/badge";
import { getDb } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { authContext } from "~/lib/auth/context";
import { isCardExpired, isCardExpiringSoon } from "~/lib/recovery/expiring-card";
import { listExpiringCardAlerts } from "~/lib/recovery/queries.server";

import type { Route } from "./+types/expiring-cards";
import { NOINDEX } from "~/lib/seo/meta";

export function meta() {
  return [{ title: "Expiring cards - Foxhound" }, NOINDEX];
}

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const db = getDb(env);
  const alerts = await listExpiringCardAlerts(db, auth.membership.accountId, { includeNoPaymentMethod: true });
  return { alerts, nowMs: Date.now() };
}

export default function ExpiringCards({ loaderData }: Route.ComponentProps) {
  const { alerts, nowMs } = loaderData;
  const now = new Date(nowMs);

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div>
        <h1 className="text-title font-medium text-text">Expiring cards</h1>
        <p className="mt-1 text-label text-text-tertiary">
          Foxhound flags cards before they expire, so the payment never has to fail in the first
          place.
        </p>
      </div>

      {alerts.length === 0 ? (
        <p className="mt-6 rounded-lg border border-dashed border-border p-6 text-body text-text-tertiary">
          No expiring cards detected yet.
        </p>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-left text-label">
            <thead>
              <tr className="border-b border-border text-micro uppercase tracking-wide text-text-tertiary">
                <th className="px-4 py-3 font-normal">Customer</th>
                <th className="px-4 py-3 font-normal">Card</th>
                <th className="px-4 py-3 font-normal">Expires</th>
                <th className="px-4 py-3 font-normal">Status</th>
                <th className="px-4 py-3 font-normal">Alert</th>
              </tr>
            </thead>
            <tbody>
              {alerts.map((alert) => {
                // A trial with nothing to charge: its month and year are the
                // trial end, so the row says so rather than naming a card.
                const noPaymentMethod = alert.reason === "no_payment_method";
                const expired = isCardExpired(alert.expiresYear, alert.expiresMonth, now);
                const expiringSoon = isCardExpiringSoon(alert.expiresYear, alert.expiresMonth, now);
                const month = `${String(alert.expiresMonth).padStart(2, "0")}/${alert.expiresYear}`;
                return (
                  <tr key={alert.id} className="border-b border-border-sub last:border-0">
                    <td className="px-4 py-3">
                      <p className="text-text">{alert.customerName ?? alert.customerEmail}</p>
                      <p className="text-micro text-text-subtle">{alert.customerEmail}</p>
                    </td>
                    <td className="px-4 py-3 text-text-tertiary">
                      {noPaymentMethod
                        ? "No payment method"
                        : `${alert.cardBrand ?? "Card"} ${alert.cardLast4 ? `•••• ${alert.cardLast4}` : ""}`}
                    </td>
                    <td className="px-4 py-3 font-mono text-text">
                      {noPaymentMethod ? `Trial ends ${month}` : month}
                    </td>
                    <td className="px-4 py-3">
                      {noPaymentMethod ? (
                        <Badge tone="neutral">{expired ? "Trial ended" : "Trial ending"}</Badge>
                      ) : (
                        <Badge tone={expired ? "failure" : expiringSoon ? "neutral" : "neutral"}>
                          {expired ? "Expired" : expiringSoon ? "Expiring soon" : "Valid"}
                        </Badge>
                      )}
                    </td>
                    <td className="px-4 py-3 text-text-tertiary">
                      {alert.alertSentAt ? `Sent ${alert.alertSentAt.toLocaleDateString()}` : "Not sent yet"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
