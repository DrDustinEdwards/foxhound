import { AdminNav } from "~/components/admin-nav";
import { getDb } from "~/db";
import { listAuditLog } from "~/lib/admin/audit-log.server";
import { cloudflareContext } from "~/lib/cloudflare-context";

import type { Route } from "./+types/audit-log";

export function meta() {
  return [{ title: "Audit log - Foxhound Admin" }];
}

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const db = getDb(env);
  const entries = await listAuditLog(db);
  return { entries };
}

export default function AdminAuditLog({ loaderData }: Route.ComponentProps) {
  const { entries } = loaderData;

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <h1 className="text-title font-medium text-text">Audit log</h1>
      <AdminNav />

      {entries.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-6 text-body text-text-tertiary">
          No operator actions recorded yet. Every admin action that changes production behavior
          writes a row here.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-left text-label">
            <thead>
              <tr className="border-b border-border text-micro uppercase tracking-wide text-text-tertiary">
                <th className="px-4 py-3 font-normal">When</th>
                <th className="px-4 py-3 font-normal">Actor</th>
                <th className="px-4 py-3 font-normal">Action</th>
                <th className="px-4 py-3 font-normal">Target</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} className="border-b border-border-sub last:border-0">
                  <td className="px-4 py-3 text-text-tertiary">{e.createdAt.toLocaleString()}</td>
                  <td className="px-4 py-3 text-text">{e.actorEmail}</td>
                  <td className="px-4 py-3 font-mono text-micro text-text">{e.action}</td>
                  <td className="px-4 py-3 text-text-tertiary">
                    {e.targetEmail ?? e.targetUserId ?? (e.metadata ? JSON.stringify(e.metadata) : "-")}
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
