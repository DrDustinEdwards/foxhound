import { Badge } from "~/components/badge";
import { IntelligenceUpsell } from "~/components/intelligence-upsell";
import { getDb } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { authContext } from "~/lib/auth/context";
import { getAlertsView, isIntelligenceEntitled } from "~/lib/intelligence/views.server";

import type { Route } from "./+types/alerts";

export function meta() {
  return [{ title: "Intelligence alerts - Foxhound" }];
}

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const db = getDb(env);
  const accountId = auth.membership.accountId;

  const entitled = await isIntelligenceEntitled(db, accountId);
  if (!entitled) return { entitled: false as const };

  const view = await getAlertsView(db, accountId);
  return { entitled: true as const, ...view };
}

function directionLabel(direction: string): string {
  return direction === "above" ? "goes above" : "goes below";
}

export default function IntelligenceAlertsPage({ loaderData }: Route.ComponentProps) {
  if (!loaderData.entitled) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8">
        <h1 className="text-title font-medium text-text">Alerts</h1>
        <IntelligenceUpsell />
      </div>
    );
  }

  const { alerts, history } = loaderData;

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <h1 className="text-title font-medium text-text">Alerts</h1>

      <section className="mt-6">
        <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Configured</p>
        {alerts.length === 0 ? (
          <p className="mt-3 rounded-lg border border-dashed border-border p-6 text-body text-text-tertiary">
            No alerts configured yet. The nightly Intelligence run checks configured alerts
            against real metrics; nothing to check until one exists.
          </p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {alerts.map((a) => (
              <li
                key={a.id}
                className="flex items-center justify-between gap-4 rounded-lg border border-border bg-surface p-4"
              >
                <div>
                  <p className="text-label text-text">
                    {a.label ?? a.metric}: {directionLabel(a.direction)} {a.thresholdValue}
                  </p>
                  <p className="mt-1 text-micro text-text-subtle">
                    {a.lastTriggeredAt ? `Last fired ${a.lastTriggeredAt.toLocaleDateString()}` : "Never fired"}
                  </p>
                </div>
                <Badge tone={a.enabled ? "success" : "neutral"}>{a.enabled ? "Enabled" : "Disabled"}</Badge>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-8">
        <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Fire history</p>
        {history.length === 0 ? (
          <p className="mt-3 text-body text-text-tertiary">No alerts have fired yet.</p>
        ) : (
          <div className="mt-3 overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-left text-label">
              <thead>
                <tr className="border-b border-border text-micro uppercase tracking-wide text-text-tertiary">
                  <th className="px-4 py-3 font-normal">Metric</th>
                  <th className="px-4 py-3 font-normal">Value</th>
                  <th className="px-4 py-3 font-normal">Threshold</th>
                  <th className="px-4 py-3 font-normal">Fired</th>
                  <th className="px-4 py-3 font-normal">Notified</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.id} className="border-b border-border-sub last:border-0">
                    <td className="px-4 py-3 text-text">{h.metric}</td>
                    <td className="px-4 py-3 font-mono text-text">{h.actualValue}</td>
                    <td className="px-4 py-3 text-text-tertiary">
                      {directionLabel(h.direction)} {h.thresholdValue}
                    </td>
                    <td className="px-4 py-3 text-text-tertiary">{h.firedAt.toLocaleString()}</td>
                    <td className="px-4 py-3">
                      <Badge tone={h.notificationSent ? "success" : "neutral"}>
                        {h.notificationSent ? "Sent" : "Not sent yet"}
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
