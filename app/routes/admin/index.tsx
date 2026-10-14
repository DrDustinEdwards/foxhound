import { Link } from "react-router";
import { ArrowRight } from "lucide-react";
import { StatTile, StatTiles, type StatTileLinkProps } from "capsomer/react/stat-tile";

import { AdminTime } from "~/components/admin-time";
import { getDb } from "~/db";
import { cronRunHref } from "~/lib/admin/crons";
import { D1_ALERT_THRESHOLD, D1_CAP_BYTES, formatBytes } from "~/lib/admin/format";
import { getPlatformOverview } from "~/lib/admin/overview.server";
import { getD1SizeBytes } from "~/lib/admin/operations.server";
import { cloudflareContext } from "~/lib/cloudflare-context";
import type { AdminHandle } from "~/lib/admin/page";
import { formatMoney } from "~/lib/money-format";

import type { Route } from "./+types/index";

export const handle: AdminHandle = { page: "Overview" };

export function meta() {
  return [{ title: "Overview - Foxhound admin" }];
}

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const db = getDb(env);

  const [overview, d1SizeBytes] = await Promise.all([getPlatformOverview(db), getD1SizeBytes(env)]);
  return { overview, d1SizeBytes };
}

// A Capsomer tile is a link or a button; with nowhere to go it would be a
// button that does nothing, so each tile opens the page behind its number.
function tileLink({ href, children, ...rest }: StatTileLinkProps) {
  return (
    <Link to={href} {...rest}>
      {children}
    </Link>
  );
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

// Dustin's review (2026-10-11): one name for this page (Overview, in the menu,
// the top bar and the tab title), Capsomer's stat tiles in the UI face, plain
// sentences in normal case, the database size said in words, every failed run
// a link to that run on its cron, relative times, and no row of buttons
// repeating the menu.
export default function AdminOverview({ loaderData }: Route.ComponentProps) {
  const { overview, d1SizeBytes } = loaderData;
  const d1Share = d1SizeBytes / D1_CAP_BYTES;
  const { failedRuns, disabledCount, lastRunAt } = overview.cronHealth;
  const failed = failedRuns.length;
  const accountCount = overview.mrrByCurrency.reduce((n, m) => n + m.accountCount, 0);
  const failedSentence =
    failed === 0
      ? "No cron runs failed in the last 24 hours."
      : `${plural(failed, "cron run", "cron runs")} failed in the last 24 hours.`;

  return (
    <div className="grid gap-6">
      <StatTiles label="Platform">
        <StatTile
          label="Merchants"
          figure={String(overview.merchantCount)}
          detail="Excludes demo accounts"
          href="/admin/merchants"
          renderLink={tileLink}
        />
        <StatTile
          href="/admin/merchants"
          renderLink={tileLink}
          label="Active recoveries"
          figure={String(overview.activeRecoveriesCount)}
          detail="Failed payments currently in a sequence"
        />
        <StatTile
          href="/admin/merchants"
          renderLink={tileLink}
          label="MRR under management"
          figure={
            overview.mrrByCurrency.length === 0
              ? "$0.00"
              : overview.mrrByCurrency.map((m) => formatMoney(m.totalCents, m.currency)).join(" + ")
          }
          detail={
            overview.mrrByCurrency.length === 0
              ? "No MRR snapshots yet"
              : `Across ${plural(accountCount, "account", "accounts")}`
          }
        />
        <StatTile
          href="/admin/operations"
          renderLink={tileLink}
          label="Database size"
          figure={formatBytes(d1SizeBytes)}
          tone={d1Share >= D1_ALERT_THRESHOLD ? "warn" : undefined}
          word={d1Share >= D1_ALERT_THRESHOLD ? "Over half full" : undefined}
          detail={`${formatShare(d1Share)} of the 10 GB the database can hold`}
        />
      </StatTiles>

      <section className="rounded-lg border border-border bg-surface p-4" aria-labelledby="cron-health">
        <div className="flex items-center justify-between">
          <h2 id="cron-health" className="text-label font-semibold text-text">
            Cron health
          </h2>
          <Link to="/admin/crons" className="inline-flex items-center gap-1 text-label text-text-tertiary hover:text-amber">
            View crons
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
        </div>
        <p className={`mt-3 text-label ${failed > 0 ? "text-error-text" : "text-success-text"}`}>
          {failed === 1 ? (
            <Link to={cronRunHref(failedRuns[0].id)} className="text-error-text underline underline-offset-2">
              {failedSentence}
            </Link>
          ) : (
            failedSentence
          )}
        </p>
        {failed > 0 ? (
          <ul className="mt-2 grid gap-1 text-label">
            {failedRuns.map((run) => (
              <li key={run.id}>
                <Link to={cronRunHref(run.id)} className="text-text underline underline-offset-2">
                  {run.cronName}
                </Link>{" "}
                <span className="text-text-tertiary">
                  failed <AdminTime at={run.finishedAt} />
                  {run.message ? `: ${run.message}` : null}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        <p className="mt-2 text-label text-text-tertiary">
          Last run <AdminTime at={lastRunAt} />
          {disabledCount > 0 ? `. ${plural(disabledCount, "cron is", "crons are")} switched off.` : null}
        </p>
      </section>
    </div>
  );
}

// "Under 0.01%" rather than a row of zeros while the database is small.
function formatShare(share: number): string {
  const pct = share * 100;
  if (pct > 0 && pct < 0.01) return "Under 0.01%";
  return `${pct.toFixed(pct < 1 ? 2 : 1)}%`;
}
