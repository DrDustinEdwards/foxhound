// GET /admin/view-as/stop: the "Stop" in the app's "Viewing as" banner, as
// Recova's "Stop impersonating" link was a GET (?stop_impersonating=1). Ends the
// open row (logged once), clears the cookie, and returns the admin to that
// merchant's admin page. Behind Access via the admin shell.
import { redirect } from "react-router";

import { getDb } from "~/db";
import { adminContext } from "~/lib/admin/context";
import { clearImpersonationCookieHeader, stopImpersonation } from "~/lib/admin/impersonation.server";
import { merchantHref } from "~/lib/admin/page";
import { cloudflareContext } from "~/lib/cloudflare-context";

import type { Route } from "./+types/view-as-stop";

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const admin = context.get(adminContext);
  const stopped = await stopImpersonation(getDb(env), request, admin.email, new Date());
  return redirect(stopped ? merchantHref(stopped.accountId) : "/admin/merchants", {
    headers: { "Set-Cookie": clearImpersonationCookieHeader() },
  });
}
