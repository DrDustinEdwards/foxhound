import { Badge } from "~/components/badge";
import { getDb } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { authContext } from "~/lib/auth/context";
import { isCardExpired, isCardExpiringSoon } from "~/lib/recovery/expiring-card";
import { listExpiringCardAlerts } from "~/lib/recovery/queries.server";

import type { Route } from "./+types/expiring-cards";
import { NOINDEX } from "~/lib/seo/meta";
import "capsomer/table.css";

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
        <div
          className="mt-6 cap-table-wrap rounded-lg border border-border"
          data-cap="table"
          data-reflow=""
          role="region"
          aria-label="Expiring cards"
          tabIndex={0}
        >
          <table className="cap-table">
            <thead>
              <tr>
                <th scope="col">Customer</th>
                <th scope="col">Card</th>
                <th scope="col">Expires</th>
                <th scope="col">Status</th>
                <th scope="col">Alert</th>
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
                  <tr key={alert.id}>
                    <td>
                      <p className="text-text">{alert.customerName ?? alert.customerEmail}</p>
                      <p className="text-micro text-text-subtle">{alert.customerEmail}</p>
                    </td>
                    <td data-label="Card" className="text-text-tertiary">
                      {noPaymentMethod
                        ? "No payment method"
                        : `${alert.cardBrand ?? "Card"} ${alert.cardLast4 ? `•••• ${alert.cardLast4}` : ""}`}
                    </td>
                    <td data-label="Expires" className="font-mono text-text">
                      {noPaymentMethod ? `Trial ends ${month}` : month}
                    </td>
                    <td data-label="Status">
                      {noPaymentMethod ? (
                        <Badge tone="neutral">{expired ? "Trial ended" : "Trial ending"}</Badge>
                      ) : (
                        <Badge tone={expired ? "failure" : expiringSoon ? "neutral" : "neutral"}>
                          {expired ? "Expired" : expiringSoon ? "Expiring soon" : "Valid"}
                        </Badge>
                      )}
                    </td>
                    <td data-label="Alert" className="text-text-tertiary">
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
