import { cloudflareContext } from "~/lib/cloudflare-context";
import { enterDemo } from "~/lib/marketing/demo-entry.server";

import type { Route } from "./+types/dashboard";

// Real GET link into the demo (TASK-foxhound-demo-entry-parity.md item 2):
// Dashboard was the one surface the dead SURFACES block on /demos introduced
// with no way to reach it. Same pattern as the other three /demos/* routes.
export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  return enterDemo(env, "dashboard");
}
