import { formatDate } from "capsomer/behavior/time";
import { getDb } from "~/db";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import { authContext } from "~/lib/auth/context";
import { getReportsArchive } from "~/lib/intelligence/views.server";

import type { Route } from "./+types/reports";
import { NOINDEX } from "~/lib/seo/meta";

export function meta() {
  return [{ title: "Intelligence reports - Foxhound" }, NOINDEX];
}

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const db = getDb(env);
  const accountId = auth.membership.accountId;

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
        <p className="fh-empty-box fh-body fh-quiet">
          No narrative reports yet. The nightly Intelligence run generates one once there is enough
          data to narrate honestly.
        </p>
      ) : (
        <ol className="cap-stack fh-reports-list" data-gap="5">
          {reports.map((r) => (
            <li key={r.id} className="fh-reports-item">
              <p className="fh-mono fh-tiny fh-quiet fh-caps">{monthLabel(r.reportMonth)}</p>
              <p className="fh-reports-line fh-body fh-text">{r.narrative}</p>
              <p className="fh-reports-line fh-tiny fh-faint">
                Generated {formatDate(r.generatedAt, { style: "medium" }) ?? ""}
              </p>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
