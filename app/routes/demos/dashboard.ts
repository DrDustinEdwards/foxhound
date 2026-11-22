import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import { enterDemo } from "~/lib/marketing/demo-entry.server";

import type { Route } from "./+types/dashboard";

// A real GET link into the demo, the same pattern as the other /demos/* routes.
export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  return enterDemo(env, "dashboard");
}
