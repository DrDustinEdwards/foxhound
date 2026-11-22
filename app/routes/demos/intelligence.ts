import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import { enterDemo } from "~/lib/marketing/demo-entry.server";

import type { Route } from "./+types/intelligence";

// A real GET link into the demo: a crawler, a bookmark, or a plain <a> all reach it.
export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  return enterDemo(env, "intelligence");
}
