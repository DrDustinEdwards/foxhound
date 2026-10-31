// aislop-ignore-next-line ai-slop/hallucinated-import -- a Workers built-in, not an npm package
import { WorkerEntrypoint } from "cloudflare:workers";
import { generateNonce, renewNonce } from "@dustinedwards/site-runtime/csp";
import { cacheKey, forReader, purgeAfterWrite, settleCacheHeaders, withPurgePages } from "@dustinedwards/site-runtime/edge-cache";
import { preloads, rootStylesheets, withPreloadHeader } from "@dustinedwards/site-runtime/preload";
import { RateLimiter } from "@dustinedwards/site-runtime/rate-limit/durable-object";
import { timedRender } from "@dustinedwards/site-runtime/server-timing";
import { canonicalRedirect } from "@dustinedwards/site-runtime/url";
import { withSentry } from "@sentry/cloudflare";
import { createRequestHandler, RouterContextProvider, type ServerBuild } from "react-router";

import { cloudflareContext } from "~/lib/cloudflare-context";
import { EMAIL_DLQ_QUEUE_NAME } from "~/lib/constants";
import { runScheduledJobs } from "~/lib/cron/run";
import { ensureCronTickerArmed } from "~/lib/cron/ticker";
import { sentryOptions } from "~/lib/errors/sentry-options";
import { applyCachePolicy, edgeCacheable, edgeRequest } from "~/lib/http/cache-policy";
import { applySecurityHeaders } from "~/lib/http/content-security-policy";
import { enforceRateLimit } from "~/lib/http/rate-limit";
import { handleMcpRequest } from "~/lib/mcp/handler.server";
import { handleQueueBatch } from "~/lib/queue/consumer";
import { FONT_PRELOADS } from "~/lib/preloads";
import { THEME_COOKIE } from "~/lib/theme";

// Durable Objects exported from the worker entry so wrangler can bind them.
export { MoneyWriteDurableObject } from "./money-writer";
export { CronLockDurableObject } from "./cron-lock";
// The five-minute ticker: runs the "*/5 * * * *" jobs from an alarm, so they
// keep running when Cloudflare stops firing that trigger (~/lib/cron/ticker.ts).
export { CronTickerDurableObject } from "./cron-ticker";
// site-runtime's limiter class, bound as AUTH_RATE_LIMITER: the sign-in and
// signup limiter (app/lib/auth/rate-limit.server.ts).
export { RateLimiter } from "@dustinedwards/site-runtime/rate-limit/durable-object";
// RATE_LIMITER (app/lib/http/rate-limit.ts) counts with the same class under
// its old name, which keeps its namespace: retiring the name would delete a
// Durable Object namespace, which waits for Dustin.
export class RateLimiterDurableObject extends RateLimiter {}
// The admin API, served only to a service binding that names this entrypoint
// (FH-20); the public fetch below does not route it.
export { AdminApi } from "./admin-api";

const serverBuild = () => import("virtual:react-router/server-build") as Promise<ServerBuild>;
const requestHandler = createRequestHandler(serverBuild, import.meta.env.MODE);

// The root stylesheets and the fonts root.tsx links, on every HTML page as the
// `Link` header Cloudflare Early Hints reads (site-runtime withPreloadHeader
// appends it, so a route's own Link stays).
async function preloadHeader(): Promise<string> {
  return preloads([...rootStylesheets(await serverBuild()), ...FONT_PRELOADS]).header;
}

export default withSentry<Env>(
  sentryOptions,
  {
    async fetch(request, env, ctx) {
      // site-runtime's generateNonce (the 16-byte base64 algorithm Foxhound had,
      // moved there in J22). Generated before the route handler runs, so both
      // the HTML (root.tsx's <Scripts>/<ScrollRestoration>, via cloudflareContext) and
      // the response header (applySecurityHeaders) below carry the exact
      // same value (TASK-foxhound-csp-nonce-hydration.md).
      const nonce = generateNonce();
      const { origin } = new URL(request.url);
      // One hop to the canonical address: https, the bare host, no trailing slash.
      const redirect = canonicalRedirect(request, { host: "foxhoundapp.com" });
      if (redirect) return applySecurityHeaders(redirect, nonce, origin);

      // Checked before the route handler runs (not after). The public bucket
      // only: sign-in, signup, reset and Better Auth's own endpoints are
      // limited inside their actions by site-runtime's limiter, where a
      // ".data" spelling of the path cannot slip past it.
      const limited = await enforceRateLimit(request, env);
      if (limited) return applyCachePolicy(request, applySecurityHeaders(limited, nonce, origin));

      // CARREL'S SITE API, before the router, with its preview links
      // (/preview/<token>, site-api's PREVIEW_LINK_PATH). Null for any other
      // path; inside /api/carrel/v1 the package enforces rate limit, key and
      // route in that order. The path is checked before the import so the adapter
      // graph stays off every page render, as the MCP mount below does.
      const { pathname } = new URL(request.url);
      if (pathname.startsWith("/api/carrel/v1") || pathname.startsWith("/preview/")) {
        const { handleCarrelRequest } = await import("~/lib/carrel/handler.server");
        const stylesheets = rootStylesheets(await serverBuild()).map((s) => s.href);
        const carrel = await handleCarrelRequest(request, env, ctx, stylesheets);
        // A preview link: noindex, private, no-store and no-referrer from the
        // package (the header set does not overwrite them, so the token, which
        // is the address, is never sent on). It writes nothing to purge.
        if (carrel && pathname.startsWith("/preview/")) {
          return applyCachePolicy(request, applySecurityHeaders(carrel, nonce, origin));
        }
        if (carrel) {
          // Any write Carrel makes (a post, its schedule, a media library
          // picture a post shows) can change a stored page, so they are all
          // dropped. Never awaited, never throws.
          purgeAfterWrite(request, carrel, ctx, `carrel ${request.method} ${pathname}`);
          return applyCachePolicy(request, applySecurityHeaders(carrel, nonce, origin));
        }
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
        if (mcp) return applyCachePolicy(request, applySecurityHeaders(mcp, nonce, origin));
      }

      // THE EDGE PAGE CACHE (site-runtime ./edge-cache). This default export
      // has the Workers cache disabled, so it runs on every request, hits
      // included, and decides here, before the cache is consulted, what may be
      // served from it: only an anonymous GET or HEAD of a public page (cache-policy.ts,
      // edgeCacheable). A request carrying a session cookie, or any cookie but
      // the theme, never reaches the Renderer and is rendered below with its own
      // nonce, stored nowhere. The key leaves out tracking parameters and holds
      // the theme. forReader tells the browser no-store when the request
      // carried any cookie but the theme, and answers a returning reader 304.
      if (edgeCacheable(request)) {
        const edge = edgeRequest(request);
        const key = cacheKey(request.url, { dimensions: { theme: edge.theme } });
        const page = await ctx.exports.Renderer.fetch(edge.request, { cf: { cacheKey: key } });
        return forReader(renewNonce(page), request, { publicCookies: [THEME_COOKIE] });
      }

      const context = new RouterContextProvider();
      context.set(cloudflareContext, { env, ctx, nonce });
      const response = await requestHandler(request, context);
      // THE CACHE POLICY, applied in the one place every response already
      // passes through. A route's own `headers` export would be
      // per route and a new route would default to nothing, which under RFC
      // 9111 heuristic freshness is not the same as "not cached".
      return withPreloadHeader(applyCachePolicy(request, applySecurityHeaders(response, nonce, origin)), await preloadHeader());
    },
    // Queue consumer for every queue wrangler.jsonc registers: foxhound-audit,
    // foxhound-email (no producer; live sends are synchronous in the recovery
    // cron), its dead-letter queue, and foxhound-email-events (bounces and
    // complaints).
    async queue(batch, env, ctx) {
      // Arms the five-minute ticker if its alarm is not set (a no-op once it
      // is). The queues run whenever mail is sent or an email event arrives, so
      // this arms the ticker soon after a deploy rather than at the next 03:00
      // UTC daily run. Off the batch's path: it never throws and is not awaited.
      ctx.waitUntil(ensureCronTickerArmed(env));
      // TWO QUEUES, ONE HANDLER. The dead-letter queue routes here too, so
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
    // Cron Triggers. Dispatch every registered job on the fired
    // schedule; each runs through runCronJob (config + interval + DO-lock gates,
    // cron_run_history logging). Jobs are independent, run sequentially to keep
    // D1 load bounded.
    async scheduled(controller, env) {
      // Every trigger, on every schedule, makes sure the five-minute ticker's
      // alarm is set, so the daily 03:00 UTC run re-arms it even while the
      // "*/5 * * * *" trigger is not firing. Idempotent, and it never throws.
      await ensureCronTickerArmed(env);
      // Dynamic, not static: keeps the billing/Intelligence-AI/recovery-tick
      // import graph (app/lib/cron/registry.ts) out of the fetch()/queue()
      // code paths, which never call this. See foxhound-audit-perf.md H-2.
      const { jobsForSchedule } = await import("~/lib/cron/registry");
      // NO TRY/CATCH HERE, AND THAT IS DELIBERATE. Per-job isolation lives in
      // runCronJob, which is total: it returns a failed outcome rather than
      // throwing, including for infrastructure failures outside the handler.
      // runScheduledJobs records each in cron_runs and throws after the last
      // job when any failed, so Cloudflare marks the invocation failed.
      await runScheduledJobs(env, jobsForSchedule(controller.cron));
    },
  } satisfies ExportedHandler<Env>,
);

/**
 * THE CACHEABLE ENTRYPOINT (site-runtime ./edge-cache; wrangler.jsonc
 * `exports`). The gateway below sends it only what edgeCacheable() allows: a
 * GET of a public page or files route whose one cookie, if any, is the theme.
 * Its responses are stored by the Workers cache under the key the gateway
 * names, so every header a stored page leaves with is set here, or it is
 * missing from every hit. The page is stored with the nonce it was rendered
 * with, and the gateway renews it for every reader (renewNonce).
 * settleCacheHeaders runs last: anything but a shared 200, a response setting a
 * cookie, or one rendered for a HEAD or for a cookie other than the theme (which
 * the key holds) leaves `private, no-store` and is stored nowhere. purgePages
 * (withPurgePages) runs here because a purge only reaches the cache of the
 * entrypoint that calls it.
 */
export class Renderer extends withPurgePages(WorkerEntrypoint<Env>) {
  override async fetch(request: Request): Promise<Response> {
    const storedNonce = generateNonce();
    const context = new RouterContextProvider();
    context.set(cloudflareContext, { env: this.env, ctx: this.ctx, nonce: undefined, storedNonce });
    const origin = new URL(request.url).origin;
    const rendered = await timedRender(async () => applySecurityHeaders(await requestHandler(request, context), storedNonce, origin));
    const page = withPreloadHeader(applyCachePolicy(request, rendered, true), await preloadHeader());
    return settleCacheHeaders(page, request, { publicCookies: [THEME_COOKIE] });
  }
}
