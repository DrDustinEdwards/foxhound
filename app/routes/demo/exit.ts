import { redirect } from "react-router";

import { cloudflareContext } from "~/lib/cloudflare-context";
import { getSession } from "~/lib/auth/session";
import { clearDemoCookieHeader, demoFallbackPath } from "~/lib/demo/session";

import type { Route } from "./+types/exit";

// Leave the read-only demo: clear the demo cookie and return to /dashboard if
// the caller also has a real session (TASK-foxhound-demo-access-parity.md's
// demo-over-session precedence means a signed-in user can be viewing the
// demo instead of their own account), or to /demos for an anonymous visitor.
// A GET is deliberate (the app-shell blocks non-GET in demo mode, so an Exit
// control must be a plain link); clearing a look-only cookie carries no CSRF
// risk.
export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const session = await getSession(env, request);
  return redirect(demoFallbackPath(Boolean(session)), {
    headers: { "Set-Cookie": clearDemoCookieHeader() },
  });
}
