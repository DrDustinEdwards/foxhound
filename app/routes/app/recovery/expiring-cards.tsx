import { Pill } from "capsomer/react/status";
import "capsomer/status.css";
import { formatDate } from "capsomer/behavior/time";
import { BADGE_PILL } from "~/lib/recovery/labels";
import { getDb } from "~/db";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";
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
  const alerts = await listExpiringCardAlerts(db, auth.membership.accountId, {
    includeNoPaymentMethod: true,
  });
  return { alerts, nowMs: Date.now() };
}

export default function ExpiringCards({ loaderData }: Route.ComponentProps) {
  const { alerts, nowMs } = loaderData;
  const now = new Date(nowMs);

  return (
    <div className="fh-list-page">
      <div>
        <h1 className="fh-title fh-medium fh-text">Expiring cards</h1>
        <p className="fh-list-page-sub fh-small fh-quiet">
          Foxhound flags cards before they expire, so the payment never has to fail in the first
          place.
        </p>
      </div>

      {alerts.length === 0 ? (
        <p className="fh-empty-box fh-body fh-quiet">No expiring cards detected yet.</p>
      ) : (
        <div
          className="fh-list-table cap-table-wrap"
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
                      <p className="fh-text">{alert.customerName ?? alert.customerEmail}</p>
                      <p className="fh-tiny fh-faint">{alert.customerEmail}</p>
                    </td>
                    <td data-label="Card" className="fh-quiet">
                      {noPaymentMethod
                        ? "No payment method"
                        : `${alert.cardBrand ?? "Card"} ${alert.cardLast4 ? `•••• ${alert.cardLast4}` : ""}`}
                    </td>
                    <td data-label="Expires" className="fh-mono fh-text">
                      {noPaymentMethod ? `Trial ends ${month}` : month}
                    </td>
                    <td data-label="Status">
                      {noPaymentMethod ? (
                        <Pill {...BADGE_PILL.neutral}>
                          {expired ? "Trial ended" : "Trial ending"}
                        </Pill>
                      ) : (
                        <Pill
                          {...BADGE_PILL[
                            expired ? "failure" : expiringSoon ? "neutral" : "neutral"
                          ]}
                        >
                          {expired ? "Expired" : expiringSoon ? "Expiring soon" : "Valid"}
                        </Pill>
                      )}
                    </td>
                    <td data-label="Alert" className="fh-quiet">
                      {alert.alertSentAt
                        ? `Sent ${formatDate(alert.alertSentAt, { style: "medium" }) ?? ""}`
                        : "Not sent yet"}
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
