import { Table } from "capsomer/react/table";
import { usePagePending } from "capsomer/react/route-hooks";
import { Link } from "capsomer/react/link";
import { Empty } from "capsomer/react/empty";
import { Panel } from "capsomer/react/panel";
import "capsomer/table.css";

import { Time } from "capsomer/react/time";
import { getDb } from "~/db";
import { describeAuditRows, listAdminAuditLog } from "~/lib/admin/audit-log.server";
import { type AdminHandle } from "~/lib/admin/page";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";

import type { Route } from "./+types/audit-log";
import { NOINDEX } from "~/lib/seo/meta";

export const handle: AdminHandle = { page: "Audit log" };

export function meta() {
  return [{ title: "Audit log - Foxhound admin" }, NOINDEX];
}

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const db = getDb(env);
  const rows = await listAdminAuditLog(db);
  const entries = await describeAuditRows(db, rows);
  return { entries };
}

const AUDIT_LOG_PATH = "/admin/platform/audit-log";
const HEADING_ID = "admin-audit-log-heading";
// A link in a table cell is given a 24 px target (WCAG 2.2, 2.5.8).
const LINK = "fh-row-link";

// One table in Capsomer's parts with plain sentence-case words, relative times with the exact time on hover, a pending state and an empty state. Columns: Time, Actor, Action, Target and Detail, readable action labels and the count of entries shown. Targets stay links to their pages. Read only.
export default function AdminAuditLog({ loaderData }: Route.ComponentProps) {
  const { entries } = loaderData;
  const pending = usePagePending(AUDIT_LOG_PATH);

  return (
    <Panel
      title="Operator actions"
      headingId={HEADING_ID}
      reading={pending}
      count={entries.length}
      flush
    >
      {entries.length === 0 ? (
        <Empty kind="nothing-yet" title="No audit log entries yet." />
      ) : (
        <Table caption="The audit log, newest first." captionHidden labelledBy={HEADING_ID} reflow>
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
                  <Time at={e.createdAt} empty="never" tip />
                </td>
                <td data-label="Actor" className="fh-break">
                  {e.actor}
                </td>
                <td data-label="Action">{e.action}</td>
                <td data-label="Target" data-wrap="">
                  {e.target === null ? (
                    <span className="fh-quiet">None</span>
                  ) : e.target.href ? (
                    <Link to={e.target.href} className={LINK}>
                      {e.target.label}
                    </Link>
                  ) : (
                    <span className="fh-break">{e.target.label}</span>
                  )}
                </td>
                <td
                  data-label="Detail"
                  data-wrap=""
                  className={e.detail === null ? "fh-quiet" : "fh-soft"}
                >
                  {e.detail ?? "None"}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Panel>
  );
}
