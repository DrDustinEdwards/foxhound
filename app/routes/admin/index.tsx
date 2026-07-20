import { Link } from "react-router";

import { AdminNav } from "~/components/admin-nav";
import { Badge } from "~/components/badge";
import { StatCard } from "~/components/stat-card";
import { getDb } from "~/db";
import { getPlatformOverview } from "~/lib/admin/overview.server";
import { D1_ALERT_THRESHOLD, D1_CAP_BYTES, getD1SizeBytes } from "~/lib/admin/operations.server";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { formatMoney } from "~/lib/money-format";

import type { Route } from "./+types/index";

export function meta() {
  return [{ title: "Admin - Foxhound" }];
}

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const db = getDb(env);

  const [overview, d1SizeBytes] = await Promise.all([getPlatformOverview(db), getD1SizeBytes(env)]);
  return { overview, d1SizeBytes };
}

export default function AdminOverview({ loaderData }: Route.ComponentProps) {
  const { overview, d1SizeBytes } = loaderData;
  const d1Pct = d1SizeBytes / D1_CAP_BYTES;

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <h1 className="text-title font-medium text-text">Admin</h1>
      <AdminNav />

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Merchants" value={String(overview.merchantCount)} subtext="Excludes demo accounts" />
        <StatCard
          label="Active recoveries"
          value={String(overview.activeRecoveriesCount)}
          subtext="Failed payments currently in a sequence"
        />
        <StatCard
          label="MRR under management"
          value={
            overview.mrrByCurrency.length === 0
              ? "$0.00"
              : overview.mrrByCurrency
                  .map((m) => formatMoney(m.totalCents, m.currency))
                  .join(" + ")
          }
          subtext={
            overview.mrrByCurrency.length === 0
              ? "No MRR snapshots yet"
              : `Across ${overview.mrrByCurrency.reduce((n, m) => n + m.accountCount, 0)} account(s)`
          }
        />
        <StatCard
          label="D1 size"
          value={`${(d1Pct * 100).toFixed(2)}%`}
          valueClassName={d1Pct >= D1_ALERT_THRESHOLD ? "text-error-text" : undefined}
          subtext="Of the 10 GB cap"
        />
      </section>

      <section className="mt-8 rounded-lg border border-border bg-surface p-4">
        <div className="flex items-center justify-between">
          <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Cron health</p>
          <Link to="/admin/crons" className="text-label text-text-tertiary hover:text-amber">
            View crons -&gt;
          </Link>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-4">
          <Badge tone={overview.cronHealth.failedLast24h > 0 ? "failure" : "success"}>
            {overview.cronHealth.failedLast24h} failed run(s) in the last 24h
          </Badge>
          <span className="text-label text-text-tertiary">
            Last run: {overview.cronHealth.lastRunAt ? overview.cronHealth.lastRunAt.toLocaleString() : "never"}
          </span>
          {overview.cronHealth.disabledCount > 0 ? (
            <Badge tone="neutral">{overview.cronHealth.disabledCount} cron(s) disabled</Badge>
          ) : null}
        </div>
      </section>

      <section className="mt-6 flex flex-wrap gap-3">
        <Link to="/admin/merchants" className="rounded-md border border-border bg-surface px-4 py-2 text-label text-text hover:border-amber">
          Merchants
        </Link>
        <Link to="/admin/operations" className="rounded-md border border-border bg-surface px-4 py-2 text-label text-text hover:border-amber">
          Operations
        </Link>
        <Link to="/admin/blog" className="rounded-md border border-border bg-surface px-4 py-2 text-label text-text hover:border-amber">
          Blog
        </Link>
        <Link to="/admin/audit-log" className="rounded-md border border-border bg-surface px-4 py-2 text-label text-text hover:border-amber">
          Audit log
        </Link>
      </section>
    </div>
  );
}
