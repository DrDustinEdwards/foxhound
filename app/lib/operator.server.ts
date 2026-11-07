// The operator API: the door Capsid Admin reaches Foxhound through (/api/operator, site-runtime ./operator, one
// implementation on every site; workers/app.ts mounts it). Checking the backups, backing up now and running a
// scheduled job now are Capsid Admin's, for every site in one place (Dustin, 2026-11-06 and 2026-11-07), so they are
// not admin API routes here. run_job runs only RUN_NOW_JOBS (app/lib/cron/registry.ts): no job that moves money,
// submits a dispute or mails a merchant is runnable now.
import { runJobTool } from "@dustinedwards/site-runtime/cron";
import { operatorResponse } from "@dustinedwards/site-runtime/operator";

import { backupStatus } from "~/lib/backup/d1-backup";
import { RUN_NOW_JOBS } from "~/lib/cron/registry";
import { runJobNowList } from "~/lib/cron/run";

/** The OPERATOR_TOKEN bearer and the per-caller limiter, 30 calls a minute; closed (503) until the secret is set. */
export function operatorAnswer(request: Request, env: Env): Promise<Response> {
  return operatorResponse(request, {
    token: env.OPERATOR_TOKEN,
    limiter: env.RATE_LIMITER,
    tools: {
      backup_status: {
        description:
          "Reads the backup state now, uncached: the newest complete D1 dump's age and each files pass (media, " +
          "evidence) with when it last completed, and a warning when any is past 26 hours.",
        run: () => backupStatus(env),
      },
      run_job: runJobTool(env.DB, () => runJobNowList(env, RUN_NOW_JOBS)),
    },
  });
}
