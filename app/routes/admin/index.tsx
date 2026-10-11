import { Link } from "react-router";
import { ArrowRight } from "lucide-react";

import { AdminTime } from "~/components/admin-time";
import { StatCard } from "~/components/stat-card";
import { getDb } from "~/db";
import { D1_ALERT_THRESHOLD, D1_CAP_BYTES, formatBytes } from "~/lib/admin/format";
import { getPlatformOverview } from "~/lib/admin/overview.server";
import { getD1SizeBytes } from "~/lib/admin/operations.server";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { formatMoney } from "~/lib/money-format";

import type { Route } from "./+types/index";

export function meta() {
  return [{ title: "Overview - Foxhound admin" }];
}

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const db = getDb(env);

  const [overview, d1SizeBytes] = await Promise.all([getPlatformOverview(db), getD1SizeBytes(env)]);
  return { overview, d1SizeBytes };
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

// Dustin's review (2026-10-11): one name for this page (Overview, in the menu,
// the heading and the tab title), plain sentences in normal case, the database
// size said in words, a real icon on the crons link, relative times, and no
// row of buttons repeating the menu.
export default function AdminOverview({ loaderData }: Route.ComponentProps) {
  const { overview, d1SizeBytes } = loaderData;
  const d1Share = d1SizeBytes / D1_CAP_BYTES;
  const failed = overview.cronHealth.failedLast24h;
  const disabled = overview.cronHealth.disabledCount;
  const accountCount = overview.mrrByCurrency.reduce((n, m) => n + m.accountCount, 0);

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <h1 className="mb-6 text-title font-medium text-text">Overview</h1>

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
              : `Across ${plural(accountCount, "account", "accounts")}`
          }
        />
        <StatCard
          label="Database size"
          value={formatBytes(d1SizeBytes)}
          valueClassName={d1Share >= D1_ALERT_THRESHOLD ? "text-error-text" : undefined}
          subtext={`${formatShare(d1Share)} of the 10 GB the database can hold`}
        />
      </section>

      <section className="mt-8 rounded-lg border border-border bg-surface p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-label font-semibold text-text">Cron health</h2>
          <Link to="/admin/crons" className="inline-flex items-center gap-1 text-label text-text-tertiary hover:text-amber">
            View crons
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
        </div>
        <p className={`mt-3 text-label ${failed > 0 ? "text-error-text" : "text-success-text"}`}>
          {failed === 0
            ? "No cron runs failed in the last 24 hours."
            : `${plural(failed, "cron run", "cron runs")} failed in the last 24 hours.`}
        </p>
        <p className="mt-1 text-label text-text-tertiary">
          Last run <AdminTime at={overview.cronHealth.lastRunAt} />
          {disabled > 0 ? `. ${plural(disabled, "cron is", "crons are")} switched off.` : null}
        </p>
      </section>
    </div>
  );
}

// "under 0.01%" rather than a row of zeros while the database is small.
function formatShare(share: number): string {
  const pct = share * 100;
  if (pct > 0 && pct < 0.01) return "Under 0.01%";
  return `${pct.toFixed(pct < 1 ? 2 : 1)}%`;
}
