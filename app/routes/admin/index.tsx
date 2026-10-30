import { useNavigation, useRevalidator } from "react-router";
import { Link } from "capsomer/react/link";
import { AttentionList, type AttentionLinkProps } from "capsomer/react/attention-list";
import { Empty } from "capsomer/react/empty";
import { Panel } from "capsomer/react/panel";
import { Row, RowList, type RowLinkProps } from "capsomer/react/row-list";
import { Spinner } from "capsomer/react/skeleton";
import { StatTile, StatTiles, type StatTileLinkProps } from "capsomer/react/stat-tile";

import { AdminTime } from "~/components/admin-time";
import { getDb } from "~/db";
import { cronRunHref } from "~/lib/admin/crons";
import { D1_ALERT_THRESHOLD, D1_CAP_BYTES, formatBytes } from "~/lib/admin/format";
import { overviewAttention, overviewAttentionGroups, overviewPending, plural } from "~/lib/admin/overview";
import { getAdminOverview, listRecentAdminActions } from "~/lib/admin/overview.server";
import { getD1SizeBytes } from "~/lib/admin/operations.server";
import { cloudflareContext } from "~/lib/cloudflare-context";
import type { AdminHandle } from "~/lib/admin/page";
import { formatMoney } from "~/lib/money-format";

import type { Route } from "./+types/index";
import { NOINDEX } from "~/lib/seo/meta";

export const handle: AdminHandle = { page: "Overview" };

export function meta() {
  return [{ title: "Overview - Foxhound admin" }, NOINDEX];
}

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const db = getDb(env);
  // One clock for the whole read: the month's start, the seven-day windows and
  // the attention rows' relative times all count from it, and the server and
  // the browser render the same words from it.
  const now = Date.now();

  const [overview, d1SizeBytes, recentActions] = await Promise.all([
    getAdminOverview(db, now),
    getD1SizeBytes(env),
    listRecentAdminActions(db),
  ]);
  return { overview, d1SizeBytes, recentActions, now };
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

function rowLink({ href, children, ...rest }: RowLinkProps | AttentionLinkProps) {
  return (
    <Link to={href} {...rest}>
      {children}
    </Link>
  );
}

/** Amounts in several currencies are never added together (RULES.md 3.20):
 *  each currency is said once, joined with a plus. */
function moneyFigure(amounts: ReadonlyArray<{ cents: number; currency: string }>): string {
  return amounts.length === 0 ? "$0.00" : amounts.map((m) => formatMoney(m.cents, m.currency)).join(" + ");
}

// The family admin pattern for an overview (Capsomer patterns.md, Q9 of
// 2026-10-14) and Dustin's review of 2026-10-11: the figures first, then the
// one worst-first list of what needs a person, then the top of the audit log
// and the crons' health, each with a link to its full page. One name for the
// page (Overview), plain sentences in normal case, numbers said in words,
// relative times with the exact time on hover, real icons, no row of buttons
// repeating the menu. Recova's overview (app/admin/page.tsx) is the inventory:
// its stats, its Needs attention and its Recent admin actions, all computed by
// Foxhound's engine.
export default function AdminOverview({ loaderData }: Route.ComponentProps) {
  const { overview, d1SizeBytes, recentActions, now } = loaderData;
  const pending = overviewPending(useNavigation(), useRevalidator().state);
  const d1Share = d1SizeBytes / D1_CAP_BYTES;
  const { failedRuns, disabledCount, lastRunAt } = overview.cronHealth;
  const failed = failedRuns.length;
  const accountCount = overview.mrrByCurrency.reduce((n, m) => n + m.accountCount, 0);
  const staleDisputes = overview.staleDisputesCount;
  const failedSentence =
    failed === 0
      ? "No cron runs failed in the last 24 hours."
      : `${plural(failed, "cron run", "cron runs")} failed in the last 24 hours.`;
  // While the page's data is read again the last good data stays on screen,
  // each list marked busy with a spinner saying so (patterns.md "Loading").
  const reading = pending ? <Spinner size="sm" label="Reading again" /> : undefined;

  return (
    <div className="grid gap-6">
      <StatTiles label="Platform">
        <StatTile
          href="/admin/merchants"
          renderLink={tileLink}
          label="MRR under management"
          figure={moneyFigure(overview.mrrByCurrency.map((m) => ({ cents: m.totalCents, currency: m.currency })))}
          detail={
            overview.mrrByCurrency.length === 0
              ? "No MRR snapshots yet"
              : `Across ${plural(accountCount, "account", "accounts")}`
          }
        />
        <StatTile
          label="Merchants"
          figure={String(overview.merchantCount)}
          detail={`${overview.pausedCount} paused. Demo accounts are not counted.`}
          href="/admin/merchants"
          renderLink={tileLink}
        />
        <StatTile
          href="/admin/merchants"
          renderLink={tileLink}
          label="Recovered this month"
          figure={moneyFigure(overview.recoveredThisMonth.byCurrency)}
          detail={`${plural(overview.recoveredThisMonth.paymentCount, "attributed payment", "attributed payments")} since the 1st (UTC)`}
        />
        <StatTile
          href="/admin/merchants"
          renderLink={tileLink}
          label="Open disputes"
          figure={String(overview.openDisputesCount)}
          detail={
            staleDisputes === 0
              ? "None a week old without a response"
              : `${staleDisputes} a week old with no response`
          }
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
          label="New connections"
          figure={String(overview.newConnectionsCount)}
          detail="Connected in the last 7 days and still connected"
        />
        <StatTile
          href="/admin/merchants"
          renderLink={tileLink}
          label="Billing exempt"
          figure={String(overview.billingExemptCount)}
          detail="Not invoiced"
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

      <div aria-busy={pending || undefined}>
        <AttentionList
          items={overviewAttention(overview, now)}
          groups={overviewAttentionGroups(overview)}
          read={reading}
          renderLink={rowLink}
        />
      </div>

      <div aria-busy={pending || undefined}>
        <Panel
          title="Recent admin actions"
          src={reading}
          more={<Link to="/admin/platform/audit-log">View audit log</Link>}
          flush
        >
          {recentActions.length === 0 ? (
            <Empty kind="nothing-yet" title="No admin actions yet.">
              Every admin action that changes production writes one here and in the audit log.
            </Empty>
          ) : (
            <RowList label="Recent admin actions" primary={false}>
              {recentActions.map((a) => (
                <Row
                  key={a.id}
                  // The row's one link opens what the action was done to, or the
                  // audit log when the action has no page of its own to open.
                  title={a.action}
                  href={a.target?.href ?? "/admin/platform/audit-log"}
                  renderLink={rowLink}
                  detail={a.target ? `${a.target.label}, by ${a.actorEmail}` : `by ${a.actorEmail}`}
                  meta={<AdminTime at={a.createdAt} />}
                />
              ))}
            </RowList>
          )}
        </Panel>
      </div>

      <div aria-busy={pending || undefined}>
        <Panel title="Cron health" src={reading} more={<Link to="/admin/platform/crons">View crons</Link>}>
          <div className="grid gap-2">
            <p className={`m-0 text-label ${failed > 0 ? "text-error-text" : "text-success-text"}`}>
              {failed === 1 ? (
                <Link to={cronRunHref(failedRuns[0].id)} className="text-error-text underline underline-offset-2">
                  {failedSentence}
                </Link>
              ) : (
                failedSentence
              )}
            </p>
            {failed > 0 ? (
              <ul className="m-0 grid gap-1 p-0 text-label">
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
            <p className="m-0 text-label text-text-tertiary">
              Last run <AdminTime at={lastRunAt} />
              {disabledCount > 0 ? `. ${plural(disabledCount, "cron is", "crons are")} switched off.` : null}
            </p>
          </div>
        </Panel>
      </div>
    </div>
  );
}

// "Under 0.01%" rather than a row of zeros while the database is small.
function formatShare(share: number): string {
  const pct = share * 100;
  if (pct > 0 && pct < 0.01) return "Under 0.01%";
  return `${pct.toFixed(pct < 1 ? 2 : 1)}%`;
}
