import { createSiteApi, type RateLimiter, type ScheduleRun, type SiteApi } from "@dustinedwards/site-api";
import { d1ScheduledUpdates } from "@dustinedwards/site-api/schedules";

import { getDb } from "~/db";
import { isWithinRateLimit } from "~/lib/http/rate-limit";
import { indexNow } from "~/lib/seo/indexnow.server";

import { carrelAdapter } from "./adapter.server";
import { carrelMediaAdapter } from "./media-adapter.server";

// Mounts site-api at /api/carrel/v1 (job_cbe1b96107fc). The guard order is the
// package's: prefix, rate limit, key, route. CARREL_SITE_KEY is a separate,
// revocable secret that is read ONLY here and reaches ONLY that prefix; every
// other route (admin, merchant, billing, webhooks) authenticates by session or
// signature and never looks at it.

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
 *  The IndexNow hook runs after a write that changes a public page and after
 *  each schedule the cron applies (job_b0b24df12155). */
function carrelSiteApi(env: Env): SiteApi {
  const db = getDb(env);
  return createSiteApi({
    // The blog's media library rides beside the posts (media-adapter.server.ts).
    adapter: { ...carrelAdapter(db, d1ScheduledUpdates(env.DB)), media: carrelMediaAdapter(env, db) },
    key: env.CARREL_SITE_KEY,
    limiter: carrelLimiter(env),
    hooks: [indexNow],
  });
}

/** Null when the request is outside the prefix, so the caller falls through.
 *  `ctx` keeps the hooks alive after the response is sent. */
export async function handleCarrelRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | null> {
  const api = carrelSiteApi(env);
  if (!api.matches(request)) return null;
  return api.handle(request, ctx);
}

/** The blog-schedules cron (app/lib/cron/registry.ts): puts every scheduled
 *  post and scheduled update whose time has come live. */
export function runBlogSchedules(env: Env, now = new Date()): Promise<ScheduleRun> {
  return carrelSiteApi(env).runSchedules({ now });
}
