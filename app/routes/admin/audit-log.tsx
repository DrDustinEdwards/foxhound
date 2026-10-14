import { Link } from "react-router";

import { AdminTime } from "~/components/admin-time";
import { getDb } from "~/db";
import { auditTarget, describeAuditAction } from "~/lib/admin/audit-describe";
import { listAuditLog, loadAuditLookups } from "~/lib/admin/audit-log.server";
import type { AdminHandle } from "~/lib/admin/page";
import { cloudflareContext } from "~/lib/cloudflare-context";

import type { Route } from "./+types/audit-log";

export const handle: AdminHandle = { page: "Audit log" };

export function meta() {
  return [{ title: "Audit log - Foxhound admin" }];
}

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const db = getDb(env);
  const rows = await listAuditLog(db);
  const lookups = await loadAuditLookups(db, rows);
  const entries = rows.map((e) => ({
    id: e.id,
    createdAt: e.createdAt,
    actorEmail: e.actorEmail,
    action: describeAuditAction(e.action),
    target: auditTarget(e, lookups),
  }));
  return { entries };
}

export default function AdminAuditLog({ loaderData }: Route.ComponentProps) {
  const { entries } = loaderData;

  return (
    <div>

      {entries.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-6 text-body text-text-tertiary">
          No operator actions recorded yet. Every admin action that changes production behavior
          writes a row here.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-left text-label">
            <thead>
              <tr className="border-b border-border text-label text-text-tertiary">
                <th className="px-4 py-3 font-normal">When</th>
                <th className="px-4 py-3 font-normal">Actor</th>
                <th className="px-4 py-3 font-normal">Action</th>
                <th className="px-4 py-3 font-normal">Target</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} className="border-b border-border-sub last:border-0">
                  <td className="px-4 py-3 text-text-tertiary"><AdminTime at={e.createdAt} /></td>
                  <td className="px-4 py-3 text-text">{e.actorEmail}</td>
                  <td className="px-4 py-3 text-text">{e.action}</td>
                  <td className="px-4 py-3 text-text-secondary">
                    {e.target === null ? (
                      <span className="text-text-subtle">None</span>
                    ) : e.target.href ? (
                      <Link to={e.target.href} className="underline underline-offset-2 hover:text-brand-text">
                        {e.target.label}
                      </Link>
                    ) : (
                      e.target.label
                    )}
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
