import { generateNonce } from "@dustinedwards/site-runtime/csp";
import { withSentry } from "@sentry/cloudflare";
import { createRequestHandler, RouterContextProvider } from "react-router";

import { cloudflareContext } from "~/lib/cloudflare-context";
import { EMAIL_DLQ_QUEUE_NAME } from "~/lib/constants";
import { runCronJob } from "~/lib/cron/run";
import { applyCachePolicy } from "~/lib/http/cache-policy";
import { applySecurityHeaders } from "~/lib/http/content-security-policy";
import { enforceRateLimit } from "~/lib/http/rate-limit";
import { handleMcpRequest } from "~/lib/mcp/handler.server";
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
      // site-runtime's generateNonce (the 16-byte base64 algorithm Foxhound had,
      // moved there in J22). Generated before the route handler runs, so both
      // the HTML (root.tsx's <Scripts>/<ScrollRestoration>, via cloudflareContext) and
      // the response header (applySecurityHeaders) below carry the exact
      // same value (TASK-foxhound-csp-nonce-hydration.md).
      const nonce = generateNonce();

      // Checked before the route handler runs (not after): a throttled
      // request must never reach a sign-in DB lookup or dispatch a
      // password-reset/verification email (audit M-1).
      const limited = await enforceRateLimit(request, env);
      if (limited) return applyCachePolicy(request, applySecurityHeaders(limited, nonce));

      // CARREL'S SITE API (job_cbe1b96107fc), before the router. Null for any path
      // outside /api/carrel/v1; inside it the package enforces rate limit, key and
      // route in that order. The path is checked before the import so the adapter
      // graph stays off every page render, as the MCP mount below does.
      if (new URL(request.url).pathname.startsWith("/api/carrel/v1")) {
        const { handleCarrelRequest } = await import("~/lib/carrel/handler.server");
        const carrel = await handleCarrelRequest(request, env, ctx);
        if (carrel) return applyCachePolicy(request, applySecurityHeaders(carrel, nonce));
      }

      // THE FOXHOUND ADMIN API (job_21de68b30fc2), before the router. Null for any
      // path outside /api/admin/v1; inside it an admin-scope key AND an acting
      // admin on ADMIN_EMAIL are checked on every call. Its only intended caller
      // is the Foxhound Admin MCP Worker over a service binding.
      if (new URL(request.url).pathname.startsWith("/api/admin/v1")) {
        const { handleAdminApiRequest } = await import("~/lib/admin-api/handler.server");
        const admin = await handleAdminApiRequest(request, env);
        if (admin) return applyCachePolicy(request, applySecurityHeaders(admin, nonce));
      }

      // THE MERCHANT MCP ENDPOINT, before the router (370, roadmap item 3).
      // It is JSON-RPC over POST with its own header contract and its own bearer
      // auth; none of the router's loader/action machinery applies, and mounting
      // it here keeps the MCP import graph off every page render. Returns null
      // for any other path, so this costs one pathname comparison.
      //
      // It still passes through applySecurityHeaders and applyCachePolicy below,
      // which is what pins it PRIVATE: the policy classifies anything unmatched
      // as private, and /mcp is unmatched deliberately.
      // THE PATH IS CHECKED HERE, BEFORE THE IMPORT, and that ordering is the
      // whole reason the endpoint is mounted at this level. A dynamic import
      // outside this branch would be evaluated on every page render, which is
      // exactly the cost the mount was meant to avoid; the branch keeps the tool
      // module's graph (thirteen helpers, the ORM, the billing and intelligence
      // views) off every marketing request.
      if (new URL(request.url).pathname === "/mcp") {
        const { MERCHANT_TOOLS } = await import("~/lib/mcp/tools.server");
        const mcp = await handleMcpRequest(request, env, MERCHANT_TOOLS);
        if (mcp) return applyCachePolicy(request, applySecurityHeaders(mcp, nonce));
      }

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
      // NO TRY/CATCH HERE, AND THAT IS DELIBERATE. Per-job isolation lives in
      // runCronJob, which is total: it returns a failed outcome rather than
      // throwing, including for infrastructure failures outside the handler. A
      // second guard here would be two guards for one rule (381 binding e), and
      // the one that a plant can drive directly is the one that keeps it.
      for (const job of jobsForSchedule(controller.cron)) {
        await runCronJob(env, job.name, job.handler);
      }
    },
  } satisfies ExportedHandler<Env>,
);
