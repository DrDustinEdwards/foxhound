import { Badge } from "~/components/badge";
import { AdminTime } from "~/components/admin-time";
import { StatCard } from "~/components/stat-card";
import { getDb } from "~/db";
import { getWebhookHealthSummary, listRecentWebhookEvents } from "~/lib/admin/webhooks.server";
import { cloudflareContext } from "~/lib/cloudflare-context";

import type { Route } from "./+types/webhooks";

export function meta() {
  return [{ title: "Webhooks - Foxhound admin" }];
}

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const db = getDb(env);
  const [summary, events] = await Promise.all([getWebhookHealthSummary(db), listRecentWebhookEvents(db)]);
  return { summary, events };
}

export default function AdminWebhooks({ loaderData }: Route.ComponentProps) {
  const { summary, events } = loaderData;

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <h1 className="mb-6 text-title font-medium text-text">Webhooks</h1>

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard label="Received (24h)" value={String(summary.totalLast24h)} />
        <StatCard
          label="Errors (24h)"
          value={String(summary.errorsLast24h)}
          valueClassName={summary.errorsLast24h > 0 ? "text-error-text" : undefined}
        />
        <StatCard
          label="Unprocessed"
          value={String(summary.unprocessedCount)}
          valueClassName={summary.unprocessedCount > 0 ? "text-error-text" : undefined}
        />
      </section>

      <section className="mt-6 rounded-lg border border-border bg-surface p-4">
        <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Recent deliveries</p>
        {events.length === 0 ? (
          <p className="mt-2 text-label text-text-tertiary">No webhook events recorded yet.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-label">
              <thead>
                <tr className="border-b border-border text-micro uppercase tracking-wide text-text-tertiary">
                  <th className="py-2 pr-4 font-normal">Event</th>
                  <th className="py-2 pr-4 font-normal">Status</th>
                  <th className="py-2 pr-4 font-normal">Received</th>
                  <th className="py-2 font-normal">Error</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.id} className="border-b border-border-sub last:border-0">
                    <td className="py-2 pr-4 font-mono text-micro text-text">{e.eventType}</td>
                    <td className="py-2 pr-4">
                      <Badge tone={e.errorMessage ? "failure" : e.processed ? "success" : "neutral"}>
                        {e.errorMessage ? "Error" : e.processed ? "Processed" : "Pending"}
                      </Badge>
                    </td>
                    <td className="py-2 pr-4 text-text-tertiary"><AdminTime at={e.receivedAt} /></td>
                    <td className="py-2 text-text-tertiary">{e.errorMessage ?? "-"}</td>
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
