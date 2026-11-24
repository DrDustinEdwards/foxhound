import { auditLogCheck } from "@dustinedwards/site-runtime/audit-log";
import {
  aiOutcomeCheck,
  authSpikeCheck,
  durableObjectCheck,
  emailCheck,
  imagesCheck,
  queueCheck,
  r2Check,
  siteHealthResponse,
} from "@dustinedwards/site-runtime/health";
import { d1FireStore } from "@dustinedwards/site-runtime/routine";

import { cronConfig, getDb } from "~/db";
import { d1BackupStatus } from "~/lib/backup/d1-backup";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import { isCronEnabled } from "~/lib/cron/gating";
import { cronEveryMinutes } from "~/lib/cron/run";

import type { Route } from "./+types/health";

// Unauthenticated health through site-runtime's siteHealthResponse: whether D1 answers, the age of the newest complete dump and of the media copy (d1-dump, warning past 26 hours), whether each other binding answers, and whether a cron job failed, overran or stopped (cron_runs). The auth-spike check counts failed sign-ins and sign-in mails in the last hour from auth_events and names only the counts. No ids, no merchant data. The backup read is held per isolate for five minutes there (an R2 list is a billed Class A operation on a public route). The helper's Cache-Control (no-store) and X-Robots-Tag stand: /health is a private path, which the cache policy leaves as it is.
// FAIL LEVEL IS D1 ALONE: without it no page, sign-in, webhook or money write works, so the site is down and 503 is true. Every other check warns, because the site still serves without it: the buckets (dispute evidence, blog media, the merchant MCP's tool-call log copies in AUDIT_BUCKET; the backups bucket is read by the backup check), Images (blog picture sizes), Workers AI (media suggestions only), AUDIT_QUEUE (the monthly audit and the audit grant revoke wait in their producers' retries), and the Durable Objects (MONEY_WRITER and the limiters stop their own writes and sign-ins, CRON_LOCK and CRON_TICKER the crons). durableObjectCheck mints an id and sends nothing, so no object is woken or billed; r2Check is one `head` of a fixed key, never a list. emailCheck proves the EMAIL binding is there and mails no one. Left out: the Renderer entrypoint (the home page check of the deploy's live gate covers it).
export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  return siteHealthResponse(env, {
    backup: () => d1BackupStatus(env),
    jobs: () => enabledCronJobs(env),
    checks: [
      r2Check("media", env.MEDIA),
      r2Check("evidence", env.EVIDENCE),
      r2Check("audit-bucket", env.AUDIT_BUCKET),
      imagesCheck("images", env.IMAGES),
      emailCheck("email", env.EMAIL),
      queueCheck("audit-queue", env.AUDIT_QUEUE),
      durableObjectCheck("money-writer", env.MONEY_WRITER),
      durableObjectCheck("cron-lock", env.CRON_LOCK),
      durableObjectCheck("cron-ticker", env.CRON_TICKER),
      durableObjectCheck("rate-limiter", env.RATE_LIMITER),
      durableObjectCheck("auth-rate-limiter", env.AUTH_RATE_LIMITER),
      authSpikeCheck(env.DB),
      // The last real winback email call failed (a spend cap, a revoked key); no model is run here.
      aiOutcomeCheck("winback-email", d1FireStore(env.DB, "ai_outcomes")),
      // The merchant MCP's tool-call log: a call started and never finished, a spike, or rows not copied to AUDIT_BUCKET for two days.
      auditLogCheck(env),
    ].map((check) => ({ ...check, level: "warn" as const })),
  });
}

/** The registry's jobs, so a job that never ran (a trigger that never fires it) warns too. A job cron_config disables is left out, since it is meant not to run, and one with a longer minimum interval is judged by it. The registry is imported here, not at the top, to keep its billing and recovery graph out of every other request. */
async function enabledCronJobs(env: Env) {
  const [{ CRON_JOBS }, config] = await Promise.all([
    import("~/lib/cron/registry"),
    getDb(env).select().from(cronConfig),
  ]);
  const byName = new Map(config.map((row) => [row.cronName, row]));
  return CRON_JOBS.filter((job) => isCronEnabled(byName.get(job.name) ?? null)).map((job) => ({
    name: job.name,
    everyMinutes: Math.max(
      cronEveryMinutes(job.schedule),
      byName.get(job.name)?.minIntervalMinutes ?? 0,
    ),
  }));
}
