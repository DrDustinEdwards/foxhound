import { cronCheck } from "@dustinedwards/site-runtime/cron";
import { authSpikeCheck, healthResponse, r2Check } from "@dustinedwards/site-runtime/health";

import { backupStatus } from "~/lib/backup/d1-backup";
import { cloudflareContext } from "~/lib/cloudflare-context";

import type { Route } from "./+types/health";

// Unauthenticated health through site-runtime's healthResponse: whether D1 answers, the age of the newest complete
// dump and of the media copy (d1-dump, warning past 26 hours), whether the media and evidence buckets answer, and whether
// a cron job failed or stopped (cron_runs). The buckets and the crons warn, since the site serves without them. The
// auth-spike check (warn) counts failed sign-ins and sign-in mails in the last hour from auth_events and names only the
// counts. No ids, no merchant data. The backup read is held per isolate for five minutes there (job_7bbec6ab48d1: an R2
// list is a billed Class A operation on a public route). The cache policy, not this route, sets Cache-Control, so the
// helper's own is removed.
export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const response = await healthResponse({
    ping: () => env.DB.prepare("select 1").first(),
    backup: () => backupStatus(env),
    // The deployed commit, which CI's deploy passes as DEPLOY_SHA (devkit's worker-deploy.yml waits for it); a manual
    // deploy has none.
    sha: (env as { DEPLOY_SHA?: string }).DEPLOY_SHA,
    checks: [
      { ...r2Check("media", env.MEDIA), level: "warn" },
      { ...r2Check("evidence", env.EVIDENCE), level: "warn" },
      cronCheck(env.DB),
      authSpikeCheck(env.DB),
    ],
  });
  response.headers.delete("Cache-Control");
  return response;
}
