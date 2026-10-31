import { schedulePurgeHook } from "@dustinedwards/site-runtime/edge-cache";
import { createSiteApi, webmentionHook, type RateLimiter, type ScheduleRun, type SiteApi } from "@dustinedwards/site-api";
import { d1ScheduledUpdates } from "@dustinedwards/site-api/schedules";
import { d1SiteApiStore } from "@dustinedwards/site-api/store";
import { notFoundReport } from "@dustinedwards/site-runtime/not-found";

import { getDb } from "~/db";
import { isWithinRateLimit } from "~/lib/http/rate-limit";
import { indexNow } from "~/lib/seo/indexnow.server";

import { carrelAdapter, type RenderPostPage } from "./adapter.server";
import { carrelMediaAdapter } from "./media-adapter.server";

// Mounts site-api at /api/carrel/v1, and its preview links at /preview/<token>.
// The guard order is the package's: prefix, rate limit, key, route.
// CARREL_SITE_KEY is a separate, revocable secret that is read ONLY here and
// reaches ONLY that prefix; every other route (admin, merchant, billing,
// webhooks) authenticates by session or signature and never looks at it. A
// preview link carries no key: its token is the address, and it shows one
// post's current source until it expires or Carrel revokes it.

const CARREL_RATE_LIMIT = { limit: 120, periodMs: 60_000 } as const;

/** The RATE_LIMITER Durable Object, not the Workers ratelimit binding, which
 *  returned success past its limit here. Unlike the auth limiter this FAILS
 *  CLOSED (the throw becomes a refusal in site-api), which suits a write API. */
function carrelLimiter(env: Env): RateLimiter {
  return {
    async limit({ key }) {
      const within = await isWithinRateLimit(env, "carrel", key, CARREL_RATE_LIMIT.limit, CARREL_RATE_LIMIT.periodMs, {
        failClosed: true,
      });
      return { success: within };
    },
  };
}

/** One site-api over the blog, for a Carrel request and for the cron alike.
 *  The store (drizzle/migrations/0064_site_api_store.sql) makes every write
 *  safe to send again under its change id, keeps the preview links and the
 *  webmentions each post sent, and holds a failed hook for the cron to retry.
 *  The hooks run after a write that changes a public page and after each
 *  schedule the cron applies: IndexNow, webmentions to the pages a post links
 *  to, and the edge-page purge. An applied schedule has no request behind it,
 *  so its purge is a hook (a Carrel request's write is purged by the gateway,
 *  workers/app.ts, which also covers media library writes). */
function carrelSiteApi(env: Env, renderPage?: RenderPostPage): SiteApi {
  const db = getDb(env);
  const store = d1SiteApiStore(env.DB);
  return createSiteApi({
    // The blog's media library rides beside the posts (media-adapter.server.ts),
    // and the 404s entry.server.tsx counts beside both, for Carrel's report.
    adapter: {
      ...carrelAdapter(db, d1ScheduledUpdates(env.DB), renderPage),
      media: carrelMediaAdapter(env, db),
      insight: { notFound: (options) => notFoundReport(env.DB, options) },
    },
    key: env.CARREL_SITE_KEY,
    limiter: carrelLimiter(env),
    store,
    hooks: [indexNow, webmentionHook({ store }), schedulePurgeHook()],
  });
}

/** Null when the request is neither under the prefix nor a preview link, so
 *  the caller falls through. `ctx` keeps the hooks alive after the response is
 *  sent; `renderPage` draws a preview through the blog route. */
export async function handleCarrelRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  renderPage?: RenderPostPage,
): Promise<Response | null> {
  const api = carrelSiteApi(env, renderPage);
  if (api.matchesPreviewLink(request)) return api.servePreviewLink(request);
  if (!api.matches(request)) return null;
  return api.handle(request, ctx);
}

/** The blog-schedules cron (app/lib/cron/registry.ts): puts every scheduled
 *  post and scheduled update whose time has come live, runs the hooks that
 *  failed earlier again, and empties the trash of posts 30 days in it. */
export function runBlogSchedules(env: Env, now = new Date()): Promise<ScheduleRun> {
  return carrelSiteApi(env).runSchedules({ now });
}
