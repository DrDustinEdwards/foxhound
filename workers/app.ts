import { withSentry } from "@sentry/cloudflare";
import { createRequestHandler, RouterContextProvider } from "react-router";

import { cloudflareContext } from "~/lib/cloudflare-context";
import { jobsForSchedule } from "~/lib/cron/registry";
import { runCronJob } from "~/lib/cron/run";
import { applySecurityHeaders } from "~/lib/http/security-headers";
import { enforceRateLimit } from "~/lib/http/rate-limit";
import { handleQueueBatch } from "~/lib/queue/consumer";

// Durable Objects exported from the worker entry so wrangler can bind them.
export { MoneyWriteDurableObject } from "./money-writer";
export { CronLockDurableObject } from "./cron-lock";
export { RateLimiterDurableObject } from "./rate-limiter";

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

export default withSentry<Env>(
  (env) => (env.SENTRY_DSN ? { dsn: env.SENTRY_DSN, tracesSampleRate: 1 } : undefined),
  {
    async fetch(request, env, ctx) {
      // Checked before the route handler runs (not after): a throttled
      // request must never reach a sign-in DB lookup or dispatch a
      // password-reset/verification email (audit M-1).
      const limited = await enforceRateLimit(request, env);
      if (limited) return applySecurityHeaders(limited);

      const context = new RouterContextProvider();
      context.set(cloudflareContext, { env, ctx });
      const response = await requestHandler(request, context);
      return applySecurityHeaders(response);
    },
    // Queue consumer (email dispatch; bounce/complaint events added in 4c-C3).
    // Inert until the queue consumer config is added to wrangler.jsonc (Dustin
    // provisions the queues + Email Service).
    async queue(batch, env) {
      await handleQueueBatch(batch, env);
    },
    // Cron Triggers (Phase 4e). Dispatch every registered job on the fired
    // schedule; each runs through runCronJob (config + interval + DO-lock gates,
    // cron_run_history logging). Jobs are independent, run sequentially to keep
    // D1 load bounded.
    async scheduled(controller, env) {
      for (const job of jobsForSchedule(controller.cron)) {
        await runCronJob(env, job.name, job.handler);
      }
    },
  } satisfies ExportedHandler<Env>,
);
