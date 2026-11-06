// The operator API's tools: the door Capsid Admin's backups reach Foxhound through (/api/operator, site-runtime
// ./operator, one implementation on every site; workers/app.ts mounts it). Checking the backups and backing up now
// are Capsid Admin's, for every site in one place (Dustin, 2026-11-06). Neither touches Stripe, D1 or money.
import type { OperatorTool } from "@dustinedwards/site-runtime/operator";
import { backupFilesNow, backupStatus } from "~/lib/backup/d1-backup";

export function operatorTools(env: Env): Record<string, OperatorTool> {
  return {
    backup_status: {
      description:
        "Reads the backup state now, uncached: the newest complete D1 dump's age and each files pass (media, evidence) " +
        "with when it last completed, and a warning when any is past 26 hours. The same read as /health's backup field.",
      run: () => backupStatus(env),
    },
    backup_media: {
      description:
        "Runs the nightly files backup now: one pass each over the blog media and the merchants' dispute evidence " +
        "(files/media/ and files/evidence/). Copy only, and it moves no money; each pass goes on where its last stopped.",
      run: async () => ({ files: await backupFilesNow(env) }),
    },
  };
}
