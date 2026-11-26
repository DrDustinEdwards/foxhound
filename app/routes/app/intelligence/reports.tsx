import { formatDate } from "capsomer/behavior/time";
import { accountScope } from "~/lib/auth/context";
import { getReportsArchive } from "~/lib/intelligence/views.server";

import type { Route } from "./+types/reports";
import { noindexMeta } from "~/lib/seo/meta";

export const meta = noindexMeta("Intelligence reports - Foxhound");

export async function loader({ context }: Route.LoaderArgs) {
  const { db, accountId } = accountScope(context);

  return { reports: await getReportsArchive(db, accountId) };
}

function monthLabel(date: Date): string {
  return date.toLocaleDateString(undefined, { year: "numeric", month: "long", timeZone: "UTC" });
}

export default function IntelligenceReportsPage({ loaderData }: Route.ComponentProps) {
  const { reports } = loaderData;

  return (
    <div className="fh-reports">
      <h1 className="fh-title fh-medium fh-text">Reports</h1>

      {reports.length === 0 ? (
        <p className="fh-empty-box fh-body fh-quiet">No reports yet.</p>
      ) : (
        <ol className="cap-stack fh-mt-6" data-gap="5">
          {reports.map((r) => (
            <li key={r.id} className="fh-box">
              <p className="fh-mono fh-tiny fh-quiet fh-caps">{monthLabel(r.reportMonth)}</p>
              <p className="fh-mt-3 fh-body fh-text">{r.narrative}</p>
              <p className="fh-mt-3 fh-tiny fh-quiet">
                Generated {formatDate(r.generatedAt, { style: "medium" }) ?? ""}
              </p>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
