import { data, Form, useNavigation } from "react-router";
import { Status, type Tone as StatusTone } from "capsomer/react/status";

import { AdminTime } from "~/components/admin-time";
import { getDb } from "~/db";
import { cronEnableConfirmPhrase, isCronEnableConfirmValid } from "~/lib/admin/brake";
import { logAdminAction } from "~/lib/admin/audit.server";
import { isKnownCronName, listCronRows, setCronEnabled } from "~/lib/admin/crons.server";
import { adminContext } from "~/lib/admin/context";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { cronAnchor, cronRunAnchor, describeCronSchedule } from "~/lib/admin/crons";
import type { AdminHandle } from "~/lib/admin/page";

import type { Route } from "./+types/crons";

export const handle: AdminHandle = { page: "Crons" };

export function meta() {
  return [{ title: "Crons - Foxhound admin" }];
}

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const db = getDb(env);
  const crons = await listCronRows(db);
  return { crons };
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
        error: `Type ${cronEnableConfirmPhrase(cronName)} exactly to enable this cron. Nothing was changed.`,
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

  return data({ ok: true });
}

// A run's status in words, with Capsomer's status glyph (shape, word and
// colour together), not an uppercase code-style badge.
const RUN_STATUS: Record<string, { tone: StatusTone; word: string }> = {
  success: { tone: "ok", word: "Succeeded" },
  failed: { tone: "crit", word: "Failed" },
  skipped: { tone: "nodata", word: "Skipped" },
};

/** Disable: one click. Enable: type the cron's own phrase first. The asymmetry
 *  is the point, so the two directions are rendered as two different controls
 *  rather than one button whose label flips. */
function CronToggle({ name, enabled, busy }: { name: string; enabled: boolean; busy: boolean }) {
  if (enabled) {
    return (
      <Form method="post">
        <input type="hidden" name="cronName" value={name} />
        <input type="hidden" name="nextEnabled" value="false" />
        <button
          type="submit"
          disabled={busy}
          className="rounded-md border border-border px-3 py-1.5 text-label text-text hover:border-amber disabled:opacity-60"
        >
          Disable
        </button>
      </Form>
    );
  }

  const phrase = cronEnableConfirmPhrase(name);
  const inputId = `confirm-enable-${name}`;
  return (
    <Form method="post" className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="cronName" value={name} />
      <input type="hidden" name="nextEnabled" value="true" />
      <label htmlFor={inputId} className="text-label text-text-secondary">
        Type <span className="font-mono text-text">{phrase}</span> to enable
      </label>
      <input
        id={inputId}
        name="confirm"
        type="text"
        autoComplete="off"
        required
        placeholder={phrase}
        className="rounded-md border border-border bg-bg px-3 py-1.5 font-mono text-label text-text placeholder:text-text-subtle"
      />
      <button
        type="submit"
        disabled={busy}
        className="rounded-md border border-red px-3 py-1.5 text-label text-error-text hover:bg-red-bg disabled:opacity-60"
      >
        Enable
      </button>
    </Form>
  );
}

export default function AdminCrons({ loaderData, actionData }: Route.ComponentProps) {
  const { crons } = loaderData;
  const busy = useNavigation().state !== "idle";

  return (
    <div className="grid gap-3">
      {actionData && "error" in actionData && actionData.error ? (
        <p role="alert" className="rounded-md border border-red bg-red-bg px-3 py-2 text-label text-error-text">
          {actionData.error}
        </p>
      ) : null}

      {crons.map((c) => {
        const words = describeCronSchedule(c.schedule);
        const status = c.lastRun ? (RUN_STATUS[c.lastRun.status] ?? { tone: "info" as const, word: c.lastRun.status }) : null;
        return (
          <section
            key={c.name}
            id={cronAnchor(c.name)}
            aria-labelledby={`${cronAnchor(c.name)}-name`}
            className="rounded-lg border border-border bg-surface p-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 id={`${cronAnchor(c.name)}-name`} className="text-body font-semibold text-text">
                  {c.name}
                </h2>
                <p className="text-label text-text-secondary">
                  {words ?? c.schedule}
                  {words ? <span className="ml-2 text-text-subtle">{c.schedule}</span> : null}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <Status tone={c.enabled ? "ok" : "nodata"}>{c.enabled ? "On" : "Switched off"}</Status>
                <CronToggle name={c.name} enabled={c.enabled} busy={busy} />
              </div>
            </div>

            <div className="mt-3 grid gap-2 border-t border-border-sub pt-3 text-label">
              {c.lastRun && status ? (
                <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="text-text-tertiary">Last run</span>
                  <Status tone={status.tone}>{status.word}</Status>
                  <span className="text-text-tertiary">
                    <AdminTime at={c.lastRun.finishedAt} />
                  </span>
                  {c.lastRun.message ? <span className="text-text-tertiary">{c.lastRun.message}</span> : null}
                </p>
              ) : (
                <p className="text-text-tertiary">No runs recorded yet.</p>
              )}

              {c.recentFailures.length > 0 ? (
                <div className="rounded-md border border-error-border bg-red-bg p-3">
                  <p className="font-semibold text-error-text">
                    {c.recentFailures.length === 1
                      ? "1 failed run in the last 24 hours"
                      : `${c.recentFailures.length} failed runs in the last 24 hours`}
                  </p>
                  <ul className="mt-1 grid gap-1">
                    {c.recentFailures.map((run) => (
                      <li key={run.id} id={cronRunAnchor(run.id)} className="rounded-sm text-text">
                        Failed <AdminTime at={run.finishedAt} />
                        {run.message ? <span className="text-text-secondary">: {run.message}</span> : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          </section>
        );
      })}
    </div>
  );
}
