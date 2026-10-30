import { useNavigation, useRevalidator } from "react-router";
import { Link } from "capsomer/react/link";
import { Empty } from "capsomer/react/empty";
import { Panel } from "capsomer/react/panel";
import { Spinner } from "capsomer/react/skeleton";
import "capsomer/table.css";

import { AdminTime } from "~/components/admin-time";
import { getDb } from "~/db";
import { auditActor, auditDetail, auditTarget, describeAuditAction } from "~/lib/admin/audit-describe";
import { listAuditLog, loadAuditLookups } from "~/lib/admin/audit-log.server";
import { plural } from "~/lib/admin/overview";
import { pagePending, type AdminHandle } from "~/lib/admin/page";
import { cloudflareContext } from "~/lib/cloudflare-context";

import type { Route } from "./+types/audit-log";
import { NOINDEX } from "~/lib/seo/meta";

export const handle: AdminHandle = { page: "Audit log" };

export function meta() {
  return [{ title: "Audit log - Foxhound admin" }, NOINDEX];
}

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const db = getDb(env);
  const rows = await listAuditLog(db);
  const lookups = await loadAuditLookups(db, rows);
  const entries = rows.map((e) => ({
    id: e.id,
    createdAt: e.createdAt,
    actor: auditActor(e.actorEmail),
    action: describeAuditAction(e.action),
    target: auditTarget(e, lookups),
    detail: auditDetail(e),
  }));
  return { entries };
}

const AUDIT_LOG_PATH = "/admin/platform/audit-log";
const HEADING_ID = "admin-audit-log-heading";
// A link in a table cell is given a 24 px target (WCAG 2.2, 2.5.8).
const LINK = "inline-block min-h-6 leading-6 text-text underline underline-offset-2 hover:text-brand-text";

// The family admin pattern (Capsomer patterns.md, Dustin's Q9 of 2026-10-14)
// and his review of 2026-10-11: one page name (the shell's "Audit log"), one
// table in Capsomer's parts with plain sentence-case words, relative times with
// the exact time on hover, a pending state and an empty state. Recova's audit
// log (app/admin/platform/audit-log/page.tsx, blob 5003157c) is the inventory:
// the Time, Actor, Action, Target and Detail columns, readable action labels
// and the count of entries shown. Foxhound's targets stay links to their pages.
// Read only: nothing here changes an entry.
export default function AdminAuditLog({ loaderData }: Route.ComponentProps) {
  const { entries } = loaderData;
  const pending = pagePending(useNavigation(), useRevalidator().state, AUDIT_LOG_PATH);

  return (
    <div aria-busy={pending || undefined}>
      <Panel
        title="Operator actions"
        headingId={HEADING_ID}
        src={pending ? <Spinner size="sm" label="Reading again" /> : undefined}
        description={
          entries.length === 0
            ? "No entries yet."
            : `Showing the last ${plural(entries.length, "entry", "entries")}, newest first.`
        }
        flush
      >
        {entries.length === 0 ? (
          <Empty kind="nothing-yet" title="No audit log entries yet.">
            Every admin action that changes how Foxhound runs writes an entry here.
          </Empty>
        ) : (
          <div className="cap-table-wrap" data-cap="table" role="region" aria-labelledby={HEADING_ID} tabIndex={0}>
            <table className="cap-table">
              <caption className="cap-sr-only">The audit log, newest first.</caption>
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">Actor</th>
                  <th scope="col">Action</th>
                  <th scope="col">Target</th>
                  <th scope="col">Detail</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id}>
                    <td>
                      <AdminTime at={e.createdAt} />
                    </td>
                    <td className="break-all">{e.actor}</td>
                    <td>{e.action}</td>
                    <td data-wrap="">
                      {e.target === null ? (
                        <span className="text-text-tertiary">None</span>
                      ) : e.target.href ? (
                        <Link to={e.target.href} className={LINK}>
                          {e.target.label}
                        </Link>
                      ) : (
                        <span className="break-all">{e.target.label}</span>
                      )}
                    </td>
                    <td data-wrap="" className={e.detail === null ? "text-text-tertiary" : "text-text-secondary"}>
                      {e.detail ?? "None"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
