import { useNavigation, useRevalidator } from "react-router";
import { Empty } from "capsomer/react/empty";
import { Meter } from "capsomer/react/meter";
import { Panel } from "capsomer/react/panel";
import { Spinner } from "capsomer/react/skeleton";
import { Status } from "capsomer/react/status";
import "capsomer/meter.css";

import { AdminTime } from "~/components/admin-time";
import { getDb } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { D1_ALERT_THRESHOLD, D1_CAP_BYTES, formatBytes } from "~/lib/admin/format";
import {
  LOCK_STATUS,
  lockSummaryWords,
  migrationsSummaryWords,
  OPERATIONS_PATH,
  settingKindWord,
} from "~/lib/admin/operations";
import { plural } from "~/lib/admin/overview";
import { pagePending, type AdminHandle } from "~/lib/admin/page";
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

export const handle: AdminHandle = { page: "Operations" };

export function meta() {
  return [{ title: "Operations - Foxhound admin" }];
}

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const db = getDb(env);
  // One clock for the queue's due steps and the locks' leases.
  const now = Date.now();

  const [queue, locks, sizeBytes, migrations, growthTables] = await Promise.all([
    getRecoveryQueueDepth(db, now),
    readCronLocks(env, now),
    getD1SizeBytes(env),
    getMigrationStatus(env),
    getGrowthTableCounts(db),
  ]);

  return {
    queue,
    locks,
    sizeBytes,
    migrations,
    growthTables,
    envSanity: getEnvSanity(env),
  };
}

const LOCKS_HEADING_ID = "admin-operations-locks-heading";
const GROWTH_HEADING_ID = "admin-operations-growth-heading";
const MIGRATIONS_HEADING_ID = "admin-operations-migrations-heading";
const SETTINGS_HEADING_ID = "admin-operations-settings-heading";

const figure = (n: number) => n.toLocaleString("en-US");

// The family admin pattern (Capsomer patterns.md, Dustin's Q9 of 2026-10-14)
// and his review of 2026-10-11: one page name (the shell's "Operations"),
// Capsomer panels and tables with plain sentence-case words, relative times
// with the exact time on hover, a pending state and an empty state on every
// list. Recova's Operations page (app/admin/operations/OperationsClient.tsx,
// blob 419a51ac) is the inventory: its queue depth and its cron-lock health are
// here, read from Foxhound's own recovery queue and CronLock Durable Objects.
// Its global pause is the Brake page and is not repeated (ruling 406 binding 3);
// its run-now panel stays out (ruling 406 binding 5); its Vercel redeploy hook
// has no Cloudflare counterpart. Foxhound's own four panels follow: database
// size, table growth, migrations and settings. Read only.
export default function AdminOperations({ loaderData }: Route.ComponentProps) {
  const { queue, locks, sizeBytes, migrations, growthTables, envSanity } = loaderData;
  const pending = pagePending(useNavigation(), useRevalidator().state, OPERATIONS_PATH);
  const spinner = pending ? <Spinner size="sm" label="Reading again" /> : undefined;
  const share = sizeBytes / D1_CAP_BYTES;
  const overHalf = share >= D1_ALERT_THRESHOLD;
  const appliedCount = migrations.rows.filter((m) => m.applied).length;

  return (
    <div className="grid grid-cols-1 gap-6" aria-busy={pending || undefined}>
      <Panel
        title="Recovery queue"
        src={spinner}
        description="Recovery work waiting on the recovery tick. Demo accounts are not counted."
      >
        <dl className="m-0 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <dt className="text-label text-text-secondary">Payments in recovery</dt>
            <dd className="m-0 font-mono text-title tabular-nums text-text">{figure(queue.activePayments)}</dd>
            <dd className="m-0 text-label text-text-secondary">Failed payments in an active sequence.</dd>
          </div>
          <div>
            <dt className="text-label text-text-secondary">Steps due now</dt>
            <dd className="m-0 font-mono text-title tabular-nums text-text">{figure(queue.dueSteps)}</dd>
            <dd className="m-0 text-label text-text-secondary">
              {queue.oldestDueAt ? (
                <>
                  Oldest due <AdminTime at={queue.oldestDueAt} />. Steps on paused or canceled accounts are not counted.
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
        src={spinner}
        description={locks.length > 0 ? lockSummaryWords(locks) : undefined}
        flush
      >
        {locks.length === 0 ? (
          <Empty kind="nothing-yet" title="No crons are registered, so there are no locks to read.">
            Each cron in Foxhound&apos;s registry takes its own lock while it runs.
          </Empty>
        ) : (
          <div className="cap-table-wrap" data-cap="table" role="region" aria-labelledby={LOCKS_HEADING_ID} tabIndex={0}>
            <table className="cap-table">
              <caption className="cap-sr-only">
                Cron locks, one per cron in the registry&apos;s order. A lock not released ran out while still stored:
                its run stopped without releasing it, or is running past its lease. The next run takes it anyway.
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

      <Panel title="Database size" src={spinner}>
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
        src={spinner}
        description="Rows in each table with a retention rule. The database reports only its whole size, so row counts are the signal per table."
        flush
      >
        {growthTables.length === 0 ? (
          <Empty kind="nothing-yet" title="No tables with a retention rule." />
        ) : (
          <div className="cap-table-wrap" data-cap="table" role="region" aria-labelledby={GROWTH_HEADING_ID} tabIndex={0}>
            <table className="cap-table">
              <caption className="cap-sr-only">Row counts for each table with a retention rule.</caption>
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
                    <th scope="row" className="font-normal text-text">
                      {t.label}
                    </th>
                    <td className="text-text-secondary">{t.retentionPolicy}</td>
                    <td data-num="">
                      {figure(t.rowCount)}
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
        src={spinner}
        description={
          migrations.rows.length > 0
            ? `${migrationsSummaryWords(appliedCount, migrations.rows.length)} The deploy itself is not readable in the Worker, so this is the sign that code and data agree.`
            : undefined
        }
        flush
      >
        {migrations.unexpectedApplied.length > 0 ? (
          <p className="m-0 border-b border-border px-4 py-3 text-label text-error-text">
            {plural(migrations.unexpectedApplied.length, "migration is", "migrations are")} applied but not in this
            build: {migrations.unexpectedApplied.join(", ")}.
          </p>
        ) : null}
        {migrations.rows.length === 0 ? (
          <Empty kind="nothing-yet" title="No migrations are recorded in this build." />
        ) : (
          <div
            className="cap-table-wrap"
            data-cap="table"
            role="region"
            aria-labelledby={MIGRATIONS_HEADING_ID}
            tabIndex={0}
          >
            <table className="cap-table">
              <caption className="cap-sr-only">Each migration in this build, in order, and when it was applied.</caption>
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
                    <th scope="row" className="font-normal font-mono text-text">
                      {m.name}
                    </th>
                    <td>
                      <Status tone={m.applied ? "ok" : "crit"}>{m.applied ? "Applied" : "Not applied"}</Status>
                    </td>
                    <td>
                      <AdminTime at={m.appliedAt} empty="Not yet" />
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
        src={spinner}
        description="Whether each binding, variable and secret the Worker uses is set, and whether the Stripe key is a live one. Names only: values are never shown here."
        flush
      >
        <div className="cap-table-wrap" data-cap="table" role="region" aria-labelledby={SETTINGS_HEADING_ID} tabIndex={0}>
          <table className="cap-table">
            <caption className="cap-sr-only">Each setting the Worker uses, its kind, and whether it is set.</caption>
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
                  <th scope="row" className="font-normal font-mono text-text">
                    {row.name}
                  </th>
                  <td className="text-text-secondary">{settingKindWord(row.kind)}</td>
                  <td>
                    {row.problem ? (
                      <Status tone="crit">{row.problem}</Status>
                    ) : (
                      <Status tone={row.set ? "ok" : "nodata"}>{row.set ? "Set" : "Not set"}</Status>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}

function LockRow({ lock }: { lock: CronLockRow }) {
  const status = LOCK_STATUS[lock.state];
  return (
    <tr>
      <th scope="row" className="font-normal font-mono text-text">
        {lock.name}
      </th>
      <td>
        <Status tone={status.tone}>{status.word}</Status>
      </td>
      <td>
        {lock.state === "running" && lock.heldUntil ? (
          <>
            Ends <AdminTime at={lock.heldUntil} />
          </>
        ) : lock.state === "not-released" && lock.heldUntil ? (
          <>
            Ran out <AdminTime at={lock.heldUntil} />
          </>
        ) : (
          <span className="text-text-tertiary">{lock.state === "unreadable" ? "Not known" : "None"}</span>
        )}
      </td>
    </tr>
  );
}
