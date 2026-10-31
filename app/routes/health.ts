import { cronCheck } from "@dustinedwards/site-runtime/cron";
import {
  aiCheck,
  authSpikeCheck,
  durableObjectCheck,
  healthResponse,
  imagesCheck,
  queueCheck,
  r2Check,
} from "@dustinedwards/site-runtime/health";

import { cronConfig, getDb } from "~/db";
import { backupStatus } from "~/lib/backup/d1-backup";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { isCronEnabled } from "~/lib/cron/gating";
import { cronEveryMinutes } from "~/lib/cron/run";

import type { Route } from "./+types/health";

// Unauthenticated health through site-runtime's healthResponse: whether D1 answers, the age of the newest complete
// dump and of the media copy (d1-dump, warning past 26 hours), whether each other binding answers, and whether a cron
// job failed, overran or stopped (cron_runs). The auth-spike check counts failed sign-ins and sign-in mails in the
// last hour from auth_events and names only the counts. No ids, no merchant data. The backup read is held per isolate
// for five minutes there (job_7bbec6ab48d1: an R2 list is a billed Class A operation on a public route). The helper's
// Cache-Control (no-store) and X-Robots-Tag stand: /health is a private path, which the cache policy leaves as it is.
//
// FAIL LEVEL IS D1 ALONE: without it no page, sign-in, webhook or money write works, so the site is down and 503 is
// true. Every other check warns, because the site still serves without it: the buckets (dispute evidence, blog media;
// the backups bucket is read by the backup check), Images (blog picture sizes), Workers AI (media suggestions only), AUDIT_QUEUE (the monthly audit and the
// audit grant revoke wait in their producers' retries), and the Durable Objects (MONEY_WRITER and the limiters stop
// their own writes and sign-ins, CRON_LOCK and CRON_TICKER the crons, which the cron check reports as well).
// durableObjectCheck mints an id and sends nothing, so no object is woken or billed. Left out: EMAIL (send_email has
// no read to probe, and a probe would send mail; a failed send is recorded in email_sends and alerted) and the
// Renderer entrypoint (the home page check of the deploy's live gate covers it).
export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  return healthResponse({
    ping: () => env.DB.prepare("select 1").first(),
    backup: () => backupStatus(env),
    // The deployed commit, which CI's deploy passes as DEPLOY_SHA (devkit's worker-deploy.yml waits for it); a manual
    // deploy has none.
    sha: (env as { DEPLOY_SHA?: string }).DEPLOY_SHA,
    checks: [
      r2Check("media", env.MEDIA),
      r2Check("evidence", env.EVIDENCE),
      imagesCheck("images", env.IMAGES),
      aiCheck("ai", env.AI),
      queueCheck("audit-queue", env.AUDIT_QUEUE),
      durableObjectCheck("money-writer", env.MONEY_WRITER),
      durableObjectCheck("cron-lock", env.CRON_LOCK),
      durableObjectCheck("cron-ticker", env.CRON_TICKER),
      durableObjectCheck("rate-limiter", env.RATE_LIMITER),
      durableObjectCheck("auth-rate-limiter", env.AUTH_RATE_LIMITER),
      cronJobsCheck(env),
      authSpikeCheck(env.DB),
    ].map((check) => ({ ...check, level: "warn" as const })),
  });
}

/** site-runtime's cronCheck over the registry's jobs, so a job that never ran (a trigger that never fires it) warns
 *  too. A job cron_config disables is left out, since it is meant not to run, and one with a longer minimum interval
 *  is judged by it. The deploy's own time holds a new job back until its first window has passed. The registry is
 *  imported here, not at the top, to keep its billing and recovery graph out of every other request. */
function cronJobsCheck(env: Env) {
  const deployedAt = env.CF_VERSION_METADATA?.timestamp ? new Date(env.CF_VERSION_METADATA.timestamp) : undefined;
  return {
    ...cronCheck(env.DB),
    run: async () => {
      const [{ CRON_JOBS }, config] = await Promise.all([
        import("~/lib/cron/registry"),
        getDb(env).select().from(cronConfig),
      ]);
      const byName = new Map(config.map((row) => [row.cronName, row]));
      const jobs = CRON_JOBS.filter((job) => isCronEnabled(byName.get(job.name) ?? null)).map((job) => ({
        name: job.name,
        everyMinutes: Math.max(cronEveryMinutes(job.schedule), byName.get(job.name)?.minIntervalMinutes ?? 0),
      }));
      return cronCheck(env.DB, { jobs, deployedAt }).run();
    },
  };
}
