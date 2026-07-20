import { AdminNav } from "~/components/admin-nav";
import { Badge } from "~/components/badge";
import { getDb } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { D1_ALERT_THRESHOLD, D1_CAP_BYTES, formatBytes } from "~/lib/admin/format";
import {
  getD1SizeBytes,
  getEnvSanity,
  getGrowthTableCounts,
  getMigrationStatus,
} from "~/lib/admin/operations.server";

import type { Route } from "./+types/operations";

export function meta() {
  return [{ title: "Operations - Foxhound Admin" }];
}

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const db = getDb(env);

  const [sizeBytes, migrations, growthTables] = await Promise.all([
    getD1SizeBytes(env),
    getMigrationStatus(env),
    getGrowthTableCounts(db),
  ]);

  return {
    sizeBytes,
    migrations,
    growthTables,
    envSanity: getEnvSanity(env),
  };
}

export default function AdminOperations({ loaderData }: Route.ComponentProps) {
  const { sizeBytes, migrations, growthTables, envSanity } = loaderData;
  const capPct = sizeBytes / D1_CAP_BYTES;
  const overAlertThreshold = capPct >= D1_ALERT_THRESHOLD;

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <h1 className="text-title font-medium text-text">Operations</h1>
      <AdminNav />

      <section className="rounded-lg border border-border bg-surface p-4">
        <div className="flex items-center justify-between">
          <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">D1 database size</p>
          {overAlertThreshold ? <Badge tone="failure">Over 50% of cap</Badge> : <Badge tone="success">Healthy</Badge>}
        </div>
        <p className="mt-2 font-mono text-title text-text">
          {formatBytes(sizeBytes)} <span className="text-text-tertiary">/ {formatBytes(D1_CAP_BYTES)}</span>
        </p>
        <p className="mt-1 text-label text-text-tertiary">{(capPct * 100).toFixed(3)}% of the 10 GB cap.</p>
      </section>

      <section className="mt-6 rounded-lg border border-border bg-surface p-4">
        <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">
          Growth-table row counts
        </p>
        <p className="mt-1 text-label text-text-tertiary">
          Per-table byte size isn't queryable from the Worker's D1 binding (only whole-database
          size is); row counts against each table's retention policy are the available signal.
        </p>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-label">
            <thead>
              <tr className="border-b border-border text-micro uppercase tracking-wide text-text-tertiary">
                <th className="py-2 pr-4 font-normal">Table</th>
                <th className="py-2 pr-4 font-normal">Retention</th>
                <th className="py-2 font-normal">Rows</th>
              </tr>
            </thead>
            <tbody>
              {growthTables.map((t) => (
                <tr key={t.label} className="border-b border-border-sub last:border-0">
                  <td className="py-2 pr-4 text-text">{t.label}</td>
                  <td className="py-2 pr-4 text-text-tertiary">{t.retentionPolicy}</td>
                  <td className="py-2 font-mono text-text">{t.rowCount.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-6 rounded-lg border border-border bg-surface p-4">
        <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">
          Migration status
        </p>
        <p className="mt-1 text-label text-text-tertiary">
          Deploy state: this Worker has no version-metadata binding wired yet, so CI/deploy status
          isn't queryable in-app; migration status against this database is the available proxy for
          whether code and data are in sync.
        </p>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-label">
            <thead>
              <tr className="border-b border-border text-micro uppercase tracking-wide text-text-tertiary">
                <th className="py-2 pr-4 font-normal">Migration</th>
                <th className="py-2 pr-4 font-normal">Status</th>
                <th className="py-2 font-normal">Applied</th>
              </tr>
            </thead>
            <tbody>
              {migrations.rows.map((m) => (
                <tr key={m.name} className="border-b border-border-sub last:border-0">
                  <td className="py-2 pr-4 font-mono text-micro text-text">{m.name}</td>
                  <td className="py-2 pr-4">
                    <Badge tone={m.applied ? "success" : "failure"}>{m.applied ? "Applied" : "Not applied"}</Badge>
                  </td>
                  <td className="py-2 text-text-tertiary">
                    {m.appliedAt ? m.appliedAt.toLocaleString() : "-"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {migrations.unexpectedApplied.length > 0 ? (
          <p className="mt-3 text-label text-error-text">
            Unexpected migrations applied but not in the known list:{" "}
            {migrations.unexpectedApplied.join(", ")}
          </p>
        ) : null}
      </section>

      <section className="mt-6 rounded-lg border border-border bg-surface p-4">
        <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Env sanity</p>
        <p className="mt-1 text-label text-text-tertiary">
          Names only. Values are never read or rendered here.
        </p>
        <div className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
          {envSanity.map((row) => (
            <div key={row.name} className="flex items-center justify-between border-b border-border-sub py-1.5">
              <span className="font-mono text-label text-text">{row.name}</span>
              <div className="flex items-center gap-2">
                <span className="font-mono text-micro uppercase tracking-wide text-text-subtle">{row.kind}</span>
                <Badge tone={row.set ? "success" : "neutral"}>{row.set ? "Set" : "Not set"}</Badge>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
