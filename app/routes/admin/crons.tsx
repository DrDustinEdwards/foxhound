import { data, Form, Link, useNavigation, useRevalidator } from "react-router";
import { ConfirmPage } from "capsomer/react/confirm-dialog";
import { Empty } from "capsomer/react/empty";
import { Panel } from "capsomer/react/panel";
import { Spinner } from "capsomer/react/skeleton";
import { Status, type Tone as StatusTone } from "capsomer/react/status";
import "capsomer/button.css";
import "capsomer/field.css";
import "capsomer/confirm-dialog.css";

import { AdminTime } from "~/components/admin-time";
import { getDb } from "~/db";
import { cronEnableConfirmPhrase, isCronEnableConfirmValid } from "~/lib/admin/brake";
import { logAdminAction } from "~/lib/admin/audit.server";
import { isKnownCronName, listCronRows, setCronEnabled, type CronRow } from "~/lib/admin/crons.server";
import { adminContext } from "~/lib/admin/context";
import { cloudflareContext } from "~/lib/cloudflare-context";
import {
  cronAnchor,
  cronEnableHref,
  cronRunAnchor,
  CRONS_PATH,
  cronsSummaryWords,
  describeCronSchedule,
  failedRunsWords,
} from "~/lib/admin/crons";
import { pagePending, type AdminHandle } from "~/lib/admin/page";

import type { Route } from "./+types/crons";

export const handle: AdminHandle = { page: "Crons" };

export function meta() {
  return [{ title: "Crons - Foxhound admin" }];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const db = getDb(env);
  const crons = await listCronRows(db);
  // ?enable=<name> opens the confirm page for a cron that is switched off. A
  // name that is unknown or already on opens nothing, so a stale link lands on
  // the table rather than on a confirmation of nothing.
  const asked = new URL(request.url).searchParams.get("enable");
  const confirmEnable = crons.find((c) => c.name === asked && !c.enabled)?.name ?? null;
  return { crons, confirmEnable };
}

export async function action({ context, request }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(adminContext);
  const db = getDb(env);

  const form = await request.formData();
  const cronName = String(form.get("cronName") ?? "");
  const nextEnabled = String(form.get("nextEnabled") ?? "") === "true";
  if (!cronName) {
    return data({ error: "Missing cron name." }, { status: 400 });
  }
  // Reject before the write AND before the audit log. setCronEnabled throws on an
  // unknown name too, but catching it here turns a 500 into a clear 400 and, more
  // importantly, stops the audit log recording a successful cron.disable for a
  // cron that does not exist.
  if (!isKnownCronName(cronName)) {
    return data({ error: `Unknown cron: ${cronName}` }, { status: 400 });
  }

  // ENABLE is type-to-confirm; DISABLE stays one click (review MEDIUM-4).
  // Stopping a scheduled job is safe and an operator in an incident should not
  // have to type to do it. Starting one is the dangerous direction, and this
  // page could restart the card-charging recovery tick with a single click while
  // the brake panel, which gates the identical action behind a phrase, went on
  // rendering "Tick DISABLED" from its own stale loader data.
  //
  // Validated before the write AND before the audit row, matching the brake
  // panel, so a mistyped confirmation never records an attempt that did not
  // happen.
  if (nextEnabled && !isCronEnableConfirmValid(cronName, String(form.get("confirm") ?? ""))) {
    return data(
      {
        error: `Type ${cronEnableConfirmPhrase(cronName)} exactly to enable this cron.`,
      },
      { status: 400 },
    );
  }

  // INTENT before STATE (review LOW-4), matching applyBrakeTransition and the
  // brake panel's own tick toggle. A failed audit insert must leave a cron's
  // enabled state unchanged, never changed-with-no-record.
  await logAdminAction(db, {
    actorEmail: auth.email,
    action: nextEnabled ? "cron.enable" : "cron.disable",
    metadata: { cronName },
  });
  await setCronEnabled(db, cronName, nextEnabled);

  return data({ ok: true as const, cronName, enabled: nextEnabled });
}

// A run's status in words, with Capsomer's status glyph (shape, word and
// colour together), not an uppercase code-style badge. Recova's status pills:
// success, failed, and "no runs" for a cron that has never run.
const RUN_STATUS: Record<string, { tone: StatusTone; word: string }> = {
  success: { tone: "ok", word: "Succeeded" },
  failed: { tone: "crit", word: "Failed" },
  skipped: { tone: "nodata", word: "Skipped" },
};

const HEADING_ID = "admin-crons-heading";

// The family admin pattern (Capsomer patterns.md, Dustin's Q9 of 2026-10-14)
// and his review of 2026-10-11: one page name (the shell's "Crons"), one table
// in Capsomer's parts with plain sentence-case words, relative times with the
// exact time on hover, a pending state and an empty state. Recova's crons page
// (app/admin/platform/crons, blobs 98fc42ff and 9a820fd4) is the inventory: a
// row per cron with its on or off state, the last run's status pill, when it
// last succeeded, the last message and a note for a cron never switched.
//
// Disable is one click; Enable opens Capsomer's confirm page and needs the
// cron's own typed phrase (APPROVED-DIFFERENCES, 2026-09-19; review MEDIUM-4).
// No Undo after a Disable: undoing it is an Enable, which must be typed. There
// is no "Run now" (ruling 406 binding 5). Everything is a form or a link, so
// the page works without script.
export default function AdminCrons({ loaderData, actionData }: Route.ComponentProps) {
  const { crons, confirmEnable } = loaderData;
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const pending = pagePending(navigation, useRevalidator().state, CRONS_PATH);
  const error = actionData && "error" in actionData ? actionData.error : null;

  if (confirmEnable) {
    const phrase = cronEnableConfirmPhrase(confirmEnable);
    return (
      <div className="grid grid-cols-1 gap-6">
        <ConfirmPage
          action={cronEnableHref(confirmEnable)}
          hidden={{ cronName: confirmEnable, nextEnabled: "true" }}
          title={`Enable ${confirmEnable}?`}
          lead="It runs again on its schedule from the next tick."
          body={["Its switch is recorded in the audit log.", "Disable stays one click if it needs stopping again."]}
          action_label="Enable cron"
          cancelHref={`${CRONS_PATH}#${cronAnchor(confirmEnable)}`}
          typeToConfirm={phrase}
          error={error}
          headingLevel="h2"
        />
      </div>
    );
  }

  const done = actionData && "ok" in actionData && actionData.ok ? actionData : null;
  const switchedOff = crons.filter((c) => !c.enabled).length;

  return (
    <div className="grid grid-cols-1 gap-6">
      {error ? (
        <p role="alert" className="rounded-md border border-red bg-red-bg px-3 py-2 text-label text-error-text">
          {error}
        </p>
      ) : null}
      {/* Present and empty until a change, so it is announced when filled. */}
      <p role="status" className={done ? "text-label text-text" : "cap-sr-only"}>
        {done ? `${done.cronName} ${done.enabled ? "is on." : "is switched off."}` : null}
      </p>

      <div aria-busy={pending || undefined}>
        <Panel
          title="Scheduled jobs"
          headingId={HEADING_ID}
          src={pending ? <Spinner size="sm" label="Reading again" /> : undefined}
          description={crons.length > 0 ? cronsSummaryWords(crons.length, switchedOff) : undefined}
          flush
        >
          {crons.length === 0 ? (
            <Empty kind="nothing-yet" title="No scheduled jobs are registered.">
              Every job in Foxhound&apos;s cron registry appears here.
            </Empty>
          ) : (
            <div className="cap-table-wrap" data-cap="table" role="region" aria-labelledby={HEADING_ID} tabIndex={0}>
              <table className="cap-table">
                <caption className="cap-sr-only">
                  Scheduled jobs, in the order the registry runs them, with each one&apos;s last run.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Cron</th>
                    <th scope="col">State</th>
                    <th scope="col">Last run</th>
                    <th scope="col">Last succeeded</th>
                    <th scope="col">Last message</th>
                    <th scope="col">Change</th>
                  </tr>
                </thead>
                <tbody>
                  {crons.map((c) => (
                    <CronTableRow key={c.name} cron={c} busy={busy} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}

function CronTableRow({ cron: c, busy }: { cron: CronRow; busy: boolean }) {
  const words = describeCronSchedule(c.schedule);
  const status = c.lastRun ? (RUN_STATUS[c.lastRun.status] ?? { tone: "info" as const, word: c.lastRun.status }) : null;
  return (
    <tr id={cronAnchor(c.name)}>
      <th scope="row" className="font-normal">
        <span className="block font-mono text-text">{c.name}</span>
        <span className="block text-text-secondary">
          {words ?? c.schedule}
          {words ? <span className="ml-2 font-mono text-text-subtle">{c.schedule}</span> : null}
        </span>
      </th>
      <td>
        <Status tone={c.enabled ? "ok" : "nodata"}>{c.enabled ? "On" : "Switched off"}</Status>
        {c.configured ? null : <span className="block text-text-secondary">On by default</span>}
      </td>
      <td>
        {c.lastRun && status ? (
          <>
            <Status tone={status.tone}>{status.word}</Status>
            <span className="block">
              <AdminTime at={c.lastRun.finishedAt} />
            </span>
          </>
        ) : (
          <Status tone="nodata">No runs yet</Status>
        )}
        {c.recentFailures.length > 0 ? (
          <div className="mt-2">
            <p className="text-error-text">{failedRunsWords(c.recentFailures.length)}</p>
            <ul className="grid gap-1">
              {c.recentFailures.map((run) => (
                <li key={run.id} id={cronRunAnchor(run.id)} className="rounded-sm text-text">
                  Failed <AdminTime at={run.finishedAt} />
                  {run.message ? <span className="text-text-secondary">: {run.message}</span> : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </td>
      <td>
        <AdminTime at={c.lastSucceededAt} empty="Never" />
      </td>
      <td data-wrap="" className={c.lastRun?.message ? "text-text" : "text-text-tertiary"}>
        {c.lastRun?.message ?? "None"}
      </td>
      <td>
        {c.enabled ? (
          <Form method="post" action={CRONS_PATH}>
            <input type="hidden" name="cronName" value={c.name} />
            <input type="hidden" name="nextEnabled" value="false" />
            <button type="submit" className="cap-btn" data-size="sm" disabled={busy}>
              Disable<span className="cap-sr-only"> {c.name}</span>
            </button>
          </Form>
        ) : (
          <Link to={cronEnableHref(c.name)} className="cap-btn" data-size="sm">
            Enable<span className="cap-sr-only"> {c.name}</span>
          </Link>
        )}
      </td>
    </tr>
  );
}
