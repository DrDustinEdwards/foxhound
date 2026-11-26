import { Table } from "capsomer/react/table";
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
import { LOCK_STATUS, OPERATIONS_PATH, settingKindWord } from "~/lib/admin/operations";
import { issueAdminApiKey, loadMcpOverview, revokeAdminApiKey } from "~/lib/admin/mcps.server";
import { adminContext } from "~/lib/admin/context";
import { API_KEY_LABEL_MAX_LENGTH } from "~/lib/settings/api-key-label";
import { readForm } from "@dustinedwards/site-runtime/body";
import { BODY_MAX_BYTES } from "~/lib/http/body";
import { data } from "react-router";
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
import { noindexMeta } from "~/lib/seo/meta";

export const handle: AdminHandle = { page: "Operations" };

export const meta = noindexMeta("Operations - Foxhound admin");

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

export interface AdminKeyActionResult {
  intent: string;
  ok: boolean;
  error?: string;
  /** The new Admin API key's plaintext, on the response that issued it only. */
  rawKey?: string;
}

/** Issue and revoke the Admin API key, the admin area's alone. The admin layout's middleware has already checked Access and the roster; each write commits with its audit row. */
export async function action({ context, request }: Route.ActionArgs) {
  const form = await readForm(request, BODY_MAX_BYTES);
  const intent = String(form.get("intent") ?? "");
  const { email } = context.get(adminContext);
  const db = getDb(context.get(cloudflareContext).env);

  if (intent === "issue-admin-key") {
    const label = String(form.get("label") ?? "").trim();
    if (!label || label.length > API_KEY_LABEL_MAX_LENGTH) {
      return data<AdminKeyActionResult>(
        {
          intent,
          ok: false,
          error: `Name the key, in ${API_KEY_LABEL_MAX_LENGTH} characters or fewer.`,
        },
        { status: 400 },
      );
    }
    const issued = await issueAdminApiKey(db, label, email);
    return data<AdminKeyActionResult>({ intent, ok: true, rawKey: issued.token });
  }

  if (intent === "revoke-admin-key") {
    const revoked = await revokeAdminApiKey(db, String(form.get("keyId") ?? ""), email);
    return revoked
      ? data<AdminKeyActionResult>({ intent, ok: true })
      : data<AdminKeyActionResult>(
          { intent, ok: false, error: "That is not a live Admin API key." },
          { status: 400 },
        );
  }

  return data<AdminKeyActionResult>(
    { intent, ok: false, error: "Unknown action." },
    { status: 400 },
  );
}

const LOCKS_HEADING_ID = "admin-operations-locks-heading";
const GROWTH_HEADING_ID = "admin-operations-growth-heading";
const MIGRATIONS_HEADING_ID = "admin-operations-migrations-heading";
const SETTINGS_HEADING_ID = "admin-operations-settings-heading";

// One page name (the shell's "Operations"), Capsomer panels and tables with plain sentence-case words, relative times with the exact time on hover, a pending state and an empty state on every list: queue depth and cron-lock health (from Foxhound's own recovery queue and CronLock Durable Objects), then database size, table growth, migrations and settings, then the MCP servers. The global pause is the Brake page and is not repeated. Read only.
export default function AdminOperations({ loaderData, actionData }: Route.ComponentProps) {
  const { queue, locks, sizeBytes, migrations, growthTables, envSanity, mcp } = loaderData;
  const pending = usePagePending(OPERATIONS_PATH);
  const share = sizeBytes / D1_CAP_BYTES;
  const overHalf = share >= D1_ALERT_THRESHOLD;

  return (
    <div className="cap-stack" data-gap="6">
      <Panel title="Recovery queue" reading={pending} meta="Demo accounts not counted">
        <dl className="fh-halves">
          <div>
            <dt className="fh-small fh-soft">Payments in recovery</dt>
            <dd className="fh-mono fh-title cap-num fh-text">
              {formatCount(queue.activePayments)}
            </dd>
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
        count={locks.length}
        flush
      >
        {locks.length === 0 ? (
          <Empty
            kind="nothing-yet"
            title="No crons are registered, so there are no locks to read."
          />
        ) : (
          <Table
            caption="Cron locks, one per cron in the registry's order. A lock not released ran out while still stored: its run stopped without releasing it, or is running past its lease. The next run takes it anyway."
            captionHidden
            labelledBy={LOCKS_HEADING_ID}
            reflow
          >
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
          </Table>
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

      <Panel title="Table growth" headingId={GROWTH_HEADING_ID} reading={pending} flush>
        {growthTables.length === 0 ? (
          <Empty kind="nothing-yet" title="No tables with a retention rule." />
        ) : (
          <Table
            caption="Row counts for each table with a retention rule."
            captionHidden
            labelledBy={GROWTH_HEADING_ID}
            reflow
          >
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
          </Table>
        )}
      </Panel>

      <Panel
        title="Migrations"
        headingId={MIGRATIONS_HEADING_ID}
        reading={pending}
        meta={`${migrations.rows.filter((m) => m.applied).length} of ${migrations.rows.length} applied`}
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
          <Table
            caption="Each migration in this build, in order, and when it was applied."
            captionHidden
            labelledBy={MIGRATIONS_HEADING_ID}
            reflow
          >
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
          </Table>
        )}
      </Panel>

      <Panel
        title="Settings"
        headingId={SETTINGS_HEADING_ID}
        reading={pending}
        meta="Names only, values never shown"
        flush
      >
        <Table
          caption="Each setting the Worker uses, its kind, and whether it is set."
          captionHidden
          labelledBy={SETTINGS_HEADING_ID}
          reflow
        >
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
                    <Status tone={row.set ? "ok" : "nodata"}>{row.set ? "Set" : "Not set"}</Status>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Panel>

      {/* Once /admin/mcps, folded in here (Dustin, 2026-10-29). */}
      <h2 className="fh-mt-5 fh-semibold fh-text">MCP servers</h2>
      <AdminMcpPanels data={mcp} reading={pending} keyAction={actionData} />
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
