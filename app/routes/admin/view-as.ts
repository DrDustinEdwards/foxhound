// POST /admin/view-as: start a read-only "View as merchant" (Recova's
// Impersonate) and land in that merchant's app. Behind Access via the admin
// shell; the row, the audit entry and the cookie come from
// app/lib/admin/impersonation.server.ts.
import { data, redirect } from "react-router";

import { getDb } from "~/db";
import { adminContext } from "~/lib/admin/context";
import { startImpersonation } from "~/lib/admin/impersonation.server";
import { cloudflareContext } from "~/lib/cloudflare-context";

import type { Route } from "./+types/view-as";
import { readForm } from "~/lib/http/body";

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const admin = context.get(adminContext);
  const form = await readForm(request);
  const accountId = String(form.get("accountId") ?? "");
  const started = accountId
    ? await startImpersonation(getDb(env), { adminEmail: admin.email, accountId, now: new Date() })
    : null;
  if (!started) return data({ ok: false, error: "No such merchant." }, { status: 400 });
  return redirect("/console", { headers: { "Set-Cookie": started.setCookie } });
}
