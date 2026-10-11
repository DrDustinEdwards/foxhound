import { Link } from "react-router";

import { AdminTime } from "~/components/admin-time";
import { Badge } from "~/components/badge";
import { getDb } from "~/db";
import { listMerchants } from "~/lib/admin/merchants.server";
import { cloudflareContext } from "~/lib/cloudflare-context";

import type { Route } from "./+types/index";

export function meta() {
  return [{ title: "Merchants - Foxhound admin" }];
}

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const db = getDb(env);
  const merchants = await listMerchants(db);
  return { merchants };
}

const CONNECTION_LABELS = {
  connected: "Connected",
  disconnected: "Disconnected",
  never_connected: "Never connected",
} as const;

export default function AdminMerchants({ loaderData }: Route.ComponentProps) {
  const { merchants } = loaderData;

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <h1 className="mb-6 text-title font-medium text-text">Merchants</h1>

      {merchants.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-6 text-body text-text-tertiary">
          No merchants yet.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-left text-label">
            <thead>
              <tr className="border-b border-border text-micro uppercase tracking-wide text-text-tertiary">
                <th className="px-4 py-3 font-normal">Account</th>
                <th className="px-4 py-3 font-normal">Connection</th>
                <th className="px-4 py-3 font-normal">Active recoveries</th>
                <th className="px-4 py-3 font-normal">Billing status</th>
                <th className="px-4 py-3 font-normal">Created</th>
              </tr>
            </thead>
            <tbody>
              {merchants.map((m) => (
                <tr key={m.id} className="border-b border-border-sub last:border-0">
                  <td className="px-4 py-3">
                    <Link to={`/admin/merchants/${m.id}`} className="text-text hover:text-amber">
                      {m.name ?? m.id}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone={m.connectionStatus === "connected" ? "success" : "neutral"}>
                      {CONNECTION_LABELS[m.connectionStatus]}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 font-mono text-text">{m.activeRecoveriesCount}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1.5">
                      {m.cancelledAt ? <Badge tone="failure">Cancelled</Badge> : null}
                      {m.billingExempt ? <Badge tone="neutral">Exempt</Badge> : null}
                      {m.processingPaused ? <Badge tone="failure">Paused</Badge> : null}
                      {!m.cancelledAt && !m.billingExempt && !m.processingPaused ? (
                        <Badge tone="success">Normal</Badge>
                      ) : null}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-text-tertiary">
                    <AdminTime at={m.createdAt} empty="-" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
