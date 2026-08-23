import { withSentry } from "@sentry/cloudflare";
import { createRequestHandler, RouterContextProvider } from "react-router";

import { cloudflareContext } from "~/lib/cloudflare-context";
import { EMAIL_DLQ_QUEUE_NAME } from "~/lib/constants";
import { runCronJob } from "~/lib/cron/run";
import { applyCachePolicy } from "~/lib/http/cache-policy";
import { applySecurityHeaders, generateNonce } from "~/lib/http/security-headers";
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
      // Generated before the route handler runs, so both the HTML
      // (root.tsx's <Scripts>/<ScrollRestoration>, via cloudflareContext) and
      // the response header (applySecurityHeaders) below carry the exact
      // same value (TASK-foxhound-csp-nonce-hydration.md).
      const nonce = generateNonce();

      // Checked before the route handler runs (not after): a throttled
      // request must never reach a sign-in DB lookup or dispatch a
      // password-reset/verification email (audit M-1).
      const limited = await enforceRateLimit(request, env);
      if (limited) return applyCachePolicy(request, applySecurityHeaders(limited, nonce));

      const context = new RouterContextProvider();
      context.set(cloudflareContext, { env, ctx, nonce });
      const response = await requestHandler(request, context);
      // THE CACHE POLICY, applied in the one place every response already
      // passes through (345 binding 4). A route's own `headers` export would be
      // per route and a new route would default to nothing, which under RFC
      // 9111 heuristic freshness is not the same as "not cached".
      return applyCachePolicy(request, applySecurityHeaders(response, nonce));
    },
    // Queue consumer (email dispatch; bounce/complaint events added in 4c-C3).
    // Inert until the queue consumer config is added to wrangler.jsonc (Dustin
    // provisions the queues + Email Service).
    async queue(batch, env) {
      // TWO QUEUES, ONE HANDLER (313). The dead-letter queue routes here too, so
      // the branch is on the queue NAME. Before this, foxhound-email-dlq had ZERO
      // consumers (measured) and a repeatedly-failing dunning email was discarded
      // with no trace after max_retries; this branch writes the row that ends
      // that. Imported dynamically for the same reason scheduled() is: it keeps
      // the dead-letter and alerting import graph out of the normal send path.
      if (batch.queue === EMAIL_DLQ_QUEUE_NAME) {
        const { recordDeadLetters } = await import("~/lib/email/dead-letters.server");
        const { getDb } = await import("~/db");
        await recordDeadLetters(
          env,
          getDb(env),
          batch.messages.map((m) => ({ id: m.id, attempts: m.attempts, body: m.body })),
          new Date(),
        );
        return;
      }
      await handleQueueBatch(batch, env);
    },
    // Cron Triggers (Phase 4e). Dispatch every registered job on the fired
    // schedule; each runs through runCronJob (config + interval + DO-lock gates,
    // cron_run_history logging). Jobs are independent, run sequentially to keep
    // D1 load bounded.
    async scheduled(controller, env) {
      // Dynamic, not static: keeps the billing/Intelligence-AI/recovery-tick
      // import graph (app/lib/cron/registry.ts) out of the fetch()/queue()
      // code paths, which never call this. See foxhound-audit-perf.md H-2.
      const { jobsForSchedule } = await import("~/lib/cron/registry");
      for (const job of jobsForSchedule(controller.cron)) {
        await runCronJob(env, job.name, job.handler);
      }
    },
  } satisfies ExportedHandler<Env>,
);
