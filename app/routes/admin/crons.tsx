import { data, Form, useNavigation } from "react-router";

import { AdminNav } from "~/components/admin-nav";
import { Badge } from "~/components/badge";
import { getDb } from "~/db";
import { cronEnableConfirmPhrase, isCronEnableConfirmValid } from "~/lib/admin/brake";
import { logAdminAction } from "~/lib/admin/audit.server";
import { isKnownCronName, listCronRows, setCronEnabled } from "~/lib/admin/crons.server";
import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";
import type { Tone } from "~/lib/recovery/labels";

import type { Route } from "./+types/crons";

export function meta() {
  return [{ title: "Crons - Foxhound Admin" }];
}

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const db = getDb(env);
  const crons = await listCronRows(db);
  return { crons };
}

export async function action({ context, request }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
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

const RUN_STATUS_TONE: Record<string, Tone> = {
  success: "success",
  failed: "failure",
  skipped: "neutral",
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
    <div className="mx-auto max-w-5xl px-4 py-8">
      <h1 className="text-title font-medium text-text">Crons</h1>
      <AdminNav />

      {actionData && "error" in actionData && actionData.error ? (
        <p role="alert" className="mb-4 rounded-md border border-red bg-red-bg px-3 py-2 text-label text-error-text">
          {actionData.error}
        </p>
      ) : null}

      <div className="flex flex-col gap-3">
        {crons.map((c) => (
          <div key={c.name} className="rounded-lg border border-border bg-surface p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="font-mono text-label text-text">{c.name}</p>
                <p className="font-mono text-micro text-text-subtle">{c.schedule}</p>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <Badge tone={c.enabled ? "success" : "neutral"}>{c.enabled ? "Enabled" : "Disabled"}</Badge>
                <CronToggle name={c.name} enabled={c.enabled} busy={busy} />
              </div>
            </div>

            <div className="mt-3 border-t border-border-sub pt-3">
              {c.lastRun ? (
                <div className="flex flex-wrap items-center gap-3 text-label">
                  <Badge tone={RUN_STATUS_TONE[c.lastRun.status] ?? "neutral"}>{c.lastRun.status}</Badge>
                  <span className="text-text-tertiary">{c.lastRun.finishedAt.toLocaleString()}</span>
                  {c.lastRun.rowsProcessed !== null ? (
                    <span className="text-text-tertiary">{c.lastRun.rowsProcessed} rows</span>
                  ) : null}
                  {c.lastRun.message ? <span className="text-text-tertiary">{c.lastRun.message}</span> : null}
                </div>
              ) : (
                <p className="text-label text-text-tertiary">No runs recorded yet.</p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
