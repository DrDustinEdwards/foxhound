import { data, Form, useNavigation } from "react-router";

import { AdminNav } from "~/components/admin-nav";
import { Badge } from "~/components/badge";
import { getDb } from "~/db";
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

  await setCronEnabled(db, cronName, nextEnabled);
  await logAdminAction(db, {
    actorEmail: auth.email,
    action: nextEnabled ? "cron.enable" : "cron.disable",
    metadata: { cronName },
  });

  return data({ ok: true });
}

const RUN_STATUS_TONE: Record<string, Tone> = {
  success: "success",
  failed: "failure",
  skipped: "neutral",
};

export default function AdminCrons({ loaderData }: Route.ComponentProps) {
  const { crons } = loaderData;
  const busy = useNavigation().state !== "idle";

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <h1 className="text-title font-medium text-text">Crons</h1>
      <AdminNav />

      <div className="flex flex-col gap-3">
        {crons.map((c) => (
          <div key={c.name} className="rounded-lg border border-border bg-surface p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="font-mono text-label text-text">{c.name}</p>
                <p className="font-mono text-micro text-text-subtle">{c.schedule}</p>
              </div>
              <div className="flex items-center gap-3">
                <Badge tone={c.enabled ? "success" : "neutral"}>{c.enabled ? "Enabled" : "Disabled"}</Badge>
                <Form method="post">
                  <input type="hidden" name="cronName" value={c.name} />
                  <input type="hidden" name="nextEnabled" value={String(!c.enabled)} />
                  <button
                    type="submit"
                    disabled={busy}
                    className="rounded-md border border-border px-3 py-1.5 text-label text-text hover:border-amber disabled:opacity-60"
                  >
                    {c.enabled ? "Disable" : "Enable"}
                  </button>
                </Form>
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
