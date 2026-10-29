import { getDb } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { authContext } from "~/lib/auth/context";
import { getReportsArchive } from "~/lib/intelligence/views.server";

import type { Route } from "./+types/reports";

export function meta() {
  return [{ title: "Intelligence reports - Foxhound" }];
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
    <div className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="text-title font-medium text-text">Reports</h1>

      {reports.length === 0 ? (
        <p className="mt-6 rounded-lg border border-dashed border-border p-6 text-body text-text-tertiary">
          No narrative reports yet. The nightly Intelligence run generates one once there is
          enough data to narrate honestly.
        </p>
      ) : (
        <ol className="mt-6 flex flex-col gap-4">
          {reports.map((r) => (
            <li key={r.id} className="rounded-lg border border-border bg-surface p-4">
              <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">
                {monthLabel(r.reportMonth)}
              </p>
              <p className="mt-2 text-body text-text">{r.narrative}</p>
              <p className="mt-2 text-micro text-text-subtle">
                Generated {r.generatedAt.toLocaleDateString()}
              </p>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
