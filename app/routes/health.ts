import { healthResponse } from "@dustinedwards/site-runtime/health";

import { backupStatus } from "~/lib/backup/d1-backup";
import { cloudflareContext } from "~/lib/cloudflare-context";

import type { Route } from "./+types/health";

// Unauthenticated health through site-runtime's healthResponse: whether D1 answers and the age of
// the newest complete dump (d1-dump's backupHealth, warning past 26 hours). No counts, no ids, no merchant data. The
// backup read is held per isolate for five minutes there (job_7bbec6ab48d1: an R2 list is a billed Class A operation on
// a public route). The cache policy, not this route, sets Cache-Control, so the helper's own is removed.
export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const response = await healthResponse({
    ping: () => env.DB.prepare("select 1").first(),
    backup: () => backupStatus(env),
    // The deployed commit, which CI's deploy passes as DEPLOY_SHA (devkit's worker-deploy.yml waits for it); a manual
    // deploy has none.
    sha: (env as { DEPLOY_SHA?: string }).DEPLOY_SHA,
  });
  response.headers.delete("Cache-Control");
  return response;
}
