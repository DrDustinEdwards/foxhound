import { usePagePending } from "capsomer/react/route-hooks";
import { Empty } from "capsomer/react/empty";
import { Meter } from "capsomer/react/meter";
import { Panel } from "capsomer/react/panel";
import { Status } from "capsomer/react/status";
import "capsomer/meter.css";

import { AdminMcpPanels } from "~/components/admin-mcp-panels";
import { Time } from "capsomer/react/time";
import { getDb } from "~/db";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import { formatBytes } from "capsomer/behavior/format";
import { D1_ALERT_THRESHOLD, D1_CAP_BYTES } from "~/lib/admin/format";
import {
  LOCK_STATUS,
  lockSummaryWords,
  migrationsSummaryWords,
  OPERATIONS_PATH,
  settingKindWord,
} from "~/lib/admin/operations";
import { loadMcpOverview } from "~/lib/admin/mcps.server";
import { formatCount, plural } from "@drdustinedwards/site-helpers/text";
import { type AdminHandle } from "~/lib/admin/page";
import {
  getD1SizeBytes,
  getEnvSanity,
  getGrowthTableCounts,
  getMigrationStatus,
  getRecoveryQueueDepth,
  readCronLocks,
  type CronLockRow,
} from "~/lib/admin/operations.server";

import type { Route } from "./+types/operations";
import { NOINDEX } from "~/lib/seo/meta";

export const handle: AdminHandle = { page: "Operations" };

export function meta() {
  return [{ title: "Operations - Foxhound admin" }, NOINDEX];
}

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const db = getDb(env);
  // One clock for the queue's due steps and the locks' leases.
  const now = Date.now();

  const [queue, locks, sizeBytes, migrations, growthTables, mcp] = await Promise.all([
    getRecoveryQueueDepth(db, now),
    readCronLocks(env, now),
    getD1SizeBytes(env),
    getMigrationStatus(env),
    getGrowthTableCounts(db),
    loadMcpOverview(db),
  ]);

  return {
    queue,
    locks,
    sizeBytes,
    migrations,
    growthTables,
    envSanity: getEnvSanity(env),
    mcp,
  };
}

const LOCKS_HEADING_ID = "admin-operations-locks-heading";
const GROWTH_HEADING_ID = "admin-operations-growth-heading";
const MIGRATIONS_HEADING_ID = "admin-operations-migrations-heading";
const SETTINGS_HEADING_ID = "admin-operations-settings-heading";

// The family admin pattern (Capsomer patterns.md, Dustin's Q9 of 2026-10-14)
// and his review of 2026-10-11: one page name (the shell's "Operations"),
// Capsomer panels and tables with plain sentence-case words, relative times
// with the exact time on hover, a pending state and an empty state on every
// list. Recova's Operations page (app/admin/operations/OperationsClient.tsx,
// blob 419a51ac) is the inventory: its queue depth and its cron-lock health are
// here, read from Foxhound's own recovery queue and CronLock Durable Objects.
// Its global pause is the Brake page and is not repeated;
// its run-now panel stays out; its Vercel redeploy hook
// has no Cloudflare counterpart. Foxhound's own four panels follow: database
// size, table growth, migrations and settings, then the MCP servers (once
// /admin/mcps). Read only.
export default function AdminOperations({ loaderData }: Route.ComponentProps) {
  const { queue, locks, sizeBytes, migrations, growthTables, envSanity, mcp } = loaderData;
  const pending = usePagePending(OPERATIONS_PATH);
  const share = sizeBytes / D1_CAP_BYTES;
  const overHalf = share >= D1_ALERT_THRESHOLD;
  const appliedCount = migrations.rows.filter((m) => m.applied).length;

  return (
    <div className="cap-stack" data-gap="6">
      <Panel
        title="Recovery queue"
        reading={pending}
        description="Recovery work waiting on the recovery tick. Demo accounts are not counted."
      >
        <dl className="fh-halves">
          <div>
            <dt className="fh-small fh-soft">Payments in recovery</dt>
            <dd className="fh-mono fh-title cap-num fh-text">
              {formatCount(queue.activePayments)}
            </dd>
            <dd className="fh-small fh-soft">Failed payments in an active sequence.</dd>
          </div>
          <div>
            <dt className="fh-small fh-soft">Steps due now</dt>
            <dd className="fh-mono fh-title cap-num fh-text">{formatCount(queue.dueSteps)}</dd>
            <dd className="fh-small fh-soft">
              {queue.oldestDueAt ? (
                <>
                  Oldest due <Time at={queue.oldestDueAt} empty="never" tip />. Steps on paused or
                  canceled accounts are not counted.
                </>
              ) : (
                "No step is waiting for the recovery tick."
              )}
            </dd>
          </div>
        </dl>
      </Panel>

      <Panel
        title="Cron locks"
        headingId={LOCKS_HEADING_ID}
        reading={pending}
        description={locks.length > 0 ? lockSummaryWords(locks) : undefined}
        flush
      >
        {locks.length === 0 ? (
          <Empty kind="nothing-yet" title="No crons are registered, so there are no locks to read.">
            Each cron in Foxhound&apos;s registry takes its own lock while it runs.
          </Empty>
        ) : (
          <div
            className="cap-table-wrap"
            data-reflow=""
            data-cap="table"
            role="region"
            aria-labelledby={LOCKS_HEADING_ID}
            tabIndex={0}
          >
            <table className="cap-table">
              <caption className="cap-sr-only">
                Cron locks, one per cron in the registry&apos;s order. A lock not released ran out
                while still stored: its run stopped without releasing it, or is running past its
                lease. The next run takes it anyway.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Cron</th>
                  <th scope="col">Lock</th>
                  <th scope="col">Lease</th>
                </tr>
              </thead>
              <tbody>
                {locks.map((lock) => (
                  <LockRow key={lock.name} lock={lock} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="Database size" reading={pending}>
        <Meter
          label="D1 database"
          value={sizeBytes}
          max={D1_CAP_BYTES}
          display={`${formatBytes(sizeBytes)} of ${formatBytes(D1_CAP_BYTES)}`}
          valueText={`${formatBytes(sizeBytes)} of ${formatBytes(D1_CAP_BYTES)} used.${overHalf ? " Over half full." : ""}`}
          tone={overHalf ? "crit" : undefined}
          words={{ warn: "Over half full", crit: "Over half full" }}
          threshold={D1_CAP_BYTES * D1_ALERT_THRESHOLD}
          note="The line marks half of the 10 GB a D1 database can hold, where Foxhound alerts."
        />
      </Panel>

      <Panel
        title="Table growth"
        headingId={GROWTH_HEADING_ID}
        reading={pending}
        description="Rows in each table with a retention rule. The database reports only its whole size, so row counts are the signal per table."
        flush
      >
        {growthTables.length === 0 ? (
          <Empty kind="nothing-yet" title="No tables with a retention rule." />
        ) : (
          <div
            className="cap-table-wrap"
            data-reflow=""
            data-cap="table"
            role="region"
            aria-labelledby={GROWTH_HEADING_ID}
            tabIndex={0}
          >
            <table className="cap-table">
              <caption className="cap-sr-only">
                Row counts for each table with a retention rule.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Table</th>
                  <th scope="col">Kept for</th>
                  <th scope="col" data-num="">
                    Rows
                  </th>
                </tr>
              </thead>
              <tbody>
                {growthTables.map((t) => (
                  <tr key={t.label}>
                    <th scope="row" className="fh-regular fh-text">
                      {t.label}
                    </th>
                    <td data-label="Kept for" className="fh-soft">
                      {t.retentionPolicy}
                    </td>
                    <td data-label="Rows" data-num="">
                      {formatCount(t.rowCount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel
        title="Migrations"
        headingId={MIGRATIONS_HEADING_ID}
        reading={pending}
        description={
          migrations.rows.length > 0
            ? `${migrationsSummaryWords(appliedCount, migrations.rows.length)} The deploy itself is not readable in the Worker, so this is the sign that code and data agree.`
            : undefined
        }
        flush
      >
        {migrations.unexpectedApplied.length > 0 ? (
          <p className="fh-panel-note fh-small fh-error">
            {plural(migrations.unexpectedApplied.length, "migration is", "migrations are")} applied
            but not in this build: {migrations.unexpectedApplied.join(", ")}.
          </p>
        ) : null}
        {migrations.rows.length === 0 ? (
          <Empty kind="nothing-yet" title="No migrations are recorded in this build." />
        ) : (
          <div
            className="cap-table-wrap"
            data-reflow=""
            data-cap="table"
            role="region"
            aria-labelledby={MIGRATIONS_HEADING_ID}
            tabIndex={0}
          >
            <table className="cap-table">
              <caption className="cap-sr-only">
                Each migration in this build, in order, and when it was applied.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Migration</th>
                  <th scope="col">State</th>
                  <th scope="col">Applied</th>
                </tr>
              </thead>
              <tbody>
                {migrations.rows.map((m) => (
                  <tr key={m.name}>
                    <th scope="row" className="fh-regular fh-mono fh-break fh-text">
                      {m.name}
                    </th>
                    <td data-label="State">
                      <Status tone={m.applied ? "ok" : "crit"}>
                        {m.applied ? "Applied" : "Not applied"}
                      </Status>
                    </td>
                    <td data-label="Applied">
                      <Time at={m.appliedAt} empty="Not yet" tip />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel
        title="Settings"
        headingId={SETTINGS_HEADING_ID}
        reading={pending}
        description="Whether each binding, variable and secret the Worker uses is set, and whether the Stripe key is a live one. Names only: values are never shown here."
        flush
      >
        <div
          className="cap-table-wrap"
          data-reflow=""
          data-cap="table"
          role="region"
          aria-labelledby={SETTINGS_HEADING_ID}
          tabIndex={0}
        >
          <table className="cap-table">
            <caption className="cap-sr-only">
              Each setting the Worker uses, its kind, and whether it is set.
            </caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Kind</th>
                <th scope="col">State</th>
              </tr>
            </thead>
            <tbody>
              {envSanity.map((row) => (
                <tr key={row.name}>
                  <th scope="row" className="fh-regular fh-mono fh-break fh-text">
                    {row.name}
                  </th>
                  <td data-label="Kind" className="fh-soft">
                    {settingKindWord(row.kind)}
                  </td>
                  <td data-label="State">
                    {row.problem ? (
                      <Status tone="crit">{row.problem}</Status>
                    ) : (
                      <Status tone={row.set ? "ok" : "nodata"}>
                        {row.set ? "Set" : "Not set"}
                      </Status>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      {/* Once /admin/mcps, folded in here (Dustin, 2026-10-29). */}
      <h2 className="fh-section-title fh-semibold fh-text">MCP servers</h2>
      <AdminMcpPanels data={mcp} reading={pending} />
    </div>
  );
}

function LockRow({ lock }: { lock: CronLockRow }) {
  const status = LOCK_STATUS[lock.state];
  return (
    <tr>
      <th scope="row" className="fh-regular fh-mono fh-break fh-text">
        {lock.name}
      </th>
      <td data-label="Lock">
        <Status tone={status.tone}>{status.word}</Status>
      </td>
      <td data-label="Lease">
        {lock.state === "running" && lock.heldUntil ? (
          <>
            Ends <Time at={lock.heldUntil} empty="never" tip />
          </>
        ) : lock.state === "not-released" && lock.heldUntil ? (
          <>
            Ran out <Time at={lock.heldUntil} empty="never" tip />
          </>
        ) : (
          <span className="fh-quiet">{lock.state === "unreadable" ? "Not known" : "None"}</span>
        )}
      </td>
    </tr>
  );
}
