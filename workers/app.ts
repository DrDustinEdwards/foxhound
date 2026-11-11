// aislop-ignore-next-line ai-slop/hallucinated-import -- a Workers built-in, not an npm package
import { WorkerEntrypoint } from "cloudflare:workers";
import { d1SiteApiStore, tombstoned } from "@dustinedwards/site-api/store";
import { generateNonce } from "@dustinedwards/site-runtime/csp";
import {
  defineSite,
  siteRenderer,
  siteWorker,
  type GatewayStep,
} from "@dustinedwards/site-runtime/worker";
import { withSentry } from "@sentry/cloudflare";
import type { ServerBuild } from "react-router";

import { markdownCopies } from "@drdustinedwards/site-helpers/markdown-copy";
import { setPageRenderer } from "~/lib/page-dates.server";
import { SITE_ORIGIN } from "~/lib/seo/jsonld";
import { codePagePaths } from "~/routes/files/sitemap";
import { EMAIL_DLQ_QUEUE_NAME } from "~/lib/constants";
import { runScheduledJobs } from "~/lib/cron/run";
import { ensureCronTickerArmed } from "~/lib/cron/ticker";
import { sentryOptions } from "~/lib/errors/sentry-options";
import { TOKEN_ROUTES } from "~/lib/errors/token-routes";
import { applyCachePolicy, cacheable } from "~/lib/http/cache-policy";
import { withSecurityHeaders } from "~/lib/http/content-security-policy";
import { SPECULATION_OPTIONS } from "~/lib/http/speculation-rules";
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
import { RateLimiter } from "@dustinedwards/site-runtime/rate-limit/durable-object";
export { RateLimiter };
// RATE_LIMITER (app/lib/http/rate-limit.ts) counts with the same class under
// its old name, which keeps its namespace: retiring the name would delete a
// Durable Object namespace, which waits for Dustin.
export class RateLimiterDurableObject extends RateLimiter {}
// The merchant MCP's append-only tool-call log, bound as TOOL_CALL_LOG
// (app/lib/mcp/call-log.server.ts).
export { ToolCallLog } from "@dustinedwards/site-runtime/audit-log";
// The admin API, served only to a service binding that names this entrypoint
// (FH-20); the public fetch below does not route it.
export { AdminApi } from "./admin-api";

const serverBuild = () => import("virtual:react-router/server-build") as Promise<ServerBuild>;

/**
 * The public request bucket, before anything else of Foxhound's runs. Sign-in, signup, reset and Better Auth's own
 * endpoints are limited inside their actions by site-runtime's limiter, where a ".data" spelling of the path cannot
 * slip past it.
 */
const rateLimit: GatewayStep<Env> = (request, env) => enforceRateLimit(request, env);

/**
 * CARREL'S SITE API with its preview links (/preview/<token>, site-api's PREVIEW_LINK_PATH). Inside /api/carrel/v1 the
 * package enforces rate limit, key and route in that order. The path is checked before the import so the adapter graph
 * stays off every page render. A preview link is noindex, private, no-store and no-referrer from the package (the set
 * does not overwrite them, so the token, which is the address, is never sent on) and writes nothing; any write Carrel
 * makes (a post, its schedule, a media library picture a post shows) can change a stored page, so the pages are purged.
 */
const carrel: GatewayStep<Env> = async (request, env, ctx, kit) => {
  const { pathname } = kit.url;
  if (!pathname.startsWith("/api/carrel/v1") && !pathname.startsWith("/preview/")) return undefined;
  const { handleCarrelRequest } = await import("~/lib/carrel/handler.server");
  // The root's stylesheets, then the blog post route's (its prose blocks), so a preview is drawn as /blog/<slug> draws
  // the post.
  const stylesheets = [
    ...(await kit.stylesheets()),
    ...((await serverBuild()).assets.routes["routes/blog/post"]?.css ?? []),
  ];
  const answer = await handleCarrelRequest(request, env, ctx, stylesheets);
  if (answer && !pathname.startsWith("/preview/"))
    kit.purgeAfterWrite(request, answer, `carrel ${request.method} ${pathname}`);
  return answer;
};

/**
 * THE OPERATOR API (app/lib/operator.server.ts): Capsid Admin's backups and run a job now, behind its own bearer. A
 * step rather than the shared `operator` option, so the cron registry is imported only on its path, never on a page
 * render.
 */
const operator: GatewayStep<Env> = async (request, env, _ctx, kit) => {
  if (kit.url.pathname !== "/api/operator") return undefined;
  const { operatorAnswer } = await import("~/lib/operator.server");
  return operatorAnswer(request, env);
};

/**
 * THE MERCHANT MCP ENDPOINT (370, roadmap item 3): JSON-RPC over POST with its own header contract and bearer auth.
 * The path is checked before the import, which keeps the tool modules' graph (the ORM, the billing and intelligence
 * views) off every marketing request. The cache policy (respond) classes /mcp private, which is what pins it no-store.
 */
const mcp: GatewayStep<Env> = async (request, env, _ctx, kit) => {
  if (kit.url.pathname !== "/mcp") return undefined;
  const { MERCHANT_TOOLS } = await import("~/lib/mcp/tools.server");
  return handleMcpRequest(request, env, MERCHANT_TOOLS);
};

// Prelum's markdownCopies: each public page has a Markdown copy at its path plus .md and answers Accept: text/markdown.
// Only the sitemap's pages get one (the pages written in code, and the blog's posts, archive and tags); the signed-in
// app, the audit, the admin and the APIs do not. /llms-full.txt stays the site's own (llmsFull: false): it states the
// product lineup and leaves pricing numbers to /pricing, which a copy built from whole pages would not.
// siteMarkdown: false makes a copy without first asking the site for the .md path, which the 404 counter would count.
const CODE_PAGES = new Set(codePagePaths());

/**
 * The site's Worker (site-runtime ./worker). What is Foxhound's own: its rate limit, Carrel's site API, the operator
 * API and the merchant MCP as steps; its route-class cache rule (respond: Vary: Cookie on public classes, private
 * no-store on the rest, CLAUDE.md rule 9); the theme in the cache key; Carrel's tombstones on a 404; the Markdown copies;
 * the admin idle sign-out; and the token routes cut from the logs.
 */
const site = defineSite<Env>({
  name: "Foxhound",
  serverBuild,
  mode: import.meta.env.MODE,
  withSecurityHeaders,
  // One hop to the canonical address: https, the bare host, no trailing slash.
  canonical: { host: "foxhoundapp.com" },
  speculationExclude: SPECULATION_OPTIONS.exclude,
  steps: [rateLimit, carrel, operator, mcp],
  publicCookies: [THEME_COOKIE],
  cacheable: (_request, url) => cacheable(url),
  preloads: [...FONT_PRELOADS],
  respond: (response, request, _env, { stored }) => applyCachePolicy(request, response, stored),
  onNotFound: (response, request, env) =>
    tombstoned(response, new URL(request.url).pathname, d1SiteApiStore(env.DB)),
  wrap: (handler) =>
    markdownCopies(handler, {
      origin: SITE_ORIGIN,
      llmsFull: false,
      siteMarkdown: false,
      skip: (path) => !(CODE_PAGES.has(path) || path.startsWith("/blog/")),
    }),
  // An admin idle for an hour is signed out of Access (site-runtime ./access).
  adminIdle: [{ secret: (env) => env.ADMIN_IDLE_SECRET }],
  // The unsubscribe, card update, engagement and invite links each carry one person's token.
  tokenRoutes: TOKEN_ROUTES,
});

// The daily page-dates job reads each code-written sitemap page as the Renderer would render it (app/lib/page-dates.server.ts).
setPageRenderer(async (path, env) => {
  const noContext = {
    waitUntil() {},
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;
  const response = await site.render(
    new Request(`https://foxhoundapp.com${path}`),
    env,
    noContext,
    {
      nonce: generateNonce(),
    },
  );
  const html = (response.headers.get("content-type") ?? "").includes("text/html");
  return response.ok && html ? response.text() : null;
});

/**
 * THE CACHEABLE ENTRYPOINT (site-runtime ./worker; wrangler.jsonc `exports`). The gateway sends it only an anonymous
 * read of a cacheable path; what it answers is stored by the Workers cache under the key the gateway names, with the
 * nonce it was rendered with, which the gateway renews for every reader.
 */
export class Renderer extends siteRenderer(WorkerEntrypoint<Env>, site) {}

const worker = siteWorker(site);

export default withSentry<Env>(sentryOptions, {
  fetch: (request, env, ctx) => worker.fetch(request, env, ctx),
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
  // Cron Triggers: Foxhound's own, not the shared `cron`, because each job runs
  // through runCronJob (config + interval + DO-lock gates, cron_run_history
  // logging) and the five-minute ticker must be re-armed on every trigger. Jobs
  // are independent, run sequentially to keep D1 load bounded.
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
} satisfies ExportedHandler<Env>);
