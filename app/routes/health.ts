import { backupStatus } from "~/lib/backup/d1-backup";
import { cloudflareContext } from "~/lib/cloudflare-context";

import type { Route } from "./+types/health";

// Unauthenticated health (job_f7f35d4b7ac7). Only fields safe for anyone to see:
// whether the app answers, and the age of the newest complete D1 dump through
// d1-dump's backupHealth (warns past 26 hours). No counts, no ids, no merchant
// data. Cache-Control is left to the cache policy, which pins unlisted routes
// private/no-store.
export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const backup = await backupStatus(env);
  return Response.json({ status: "ok", backup });
}
