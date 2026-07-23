import { cloudflareContext } from "~/lib/cloudflare-context";
import { enterDemo } from "~/lib/marketing/demo-entry.server";

import type { Route } from "./+types/intelligence";

// Real GET link into the demo (TASK-foxhound-demo-entry-parity.md item 1):
// a crawler, a bookmark, or a plain <a> all reach this the same way the old
// POST-only card never could.
export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  return enterDemo(env, "intelligence");
}
