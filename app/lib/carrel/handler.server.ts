import { createSiteApi, type RateLimiter } from "@dustinedwards/site-api";

import { getDb } from "~/db";
import { blogPostUrl, scheduleIndexNow } from "~/lib/seo/indexnow.server";

import { carrelAdapter } from "./adapter.server";

// Mounts site-api at /api/carrel/v1 (job_cbe1b96107fc). The guard order is the
// package's: prefix, rate limit, key, route. CARREL_SITE_KEY is a separate,
// revocable secret that is read ONLY here and reaches ONLY that prefix; every
// other route (admin, merchant, billing, webhooks) authenticates by session or
// signature and never looks at it.

const CARREL_RATE_LIMIT = { limit: 120, periodMs: 60_000 } as const;

/** The repo's own Durable Object limiter, not the Workers ratelimit binding:
 *  workers/rate-limiter.ts records that binding returned success past its limit
 *  here. Unlike the auth limiter this FAILS CLOSED (a throw becomes a refusal in
 *  site-api), which suits a write API. */
function carrelLimiter(env: Env): RateLimiter {
  return {
    async limit({ key }) {
      const ns = env.RATE_LIMITER;
      const stub = ns.get(ns.idFromName(`carrel:${key}`));
      const { allowed } = await stub.check(CARREL_RATE_LIMIT.limit, CARREL_RATE_LIMIT.periodMs);
      return { success: allowed };
    },
  };
}

/** Null when the request is outside the prefix, so the caller falls through.
 *  `ctx` keeps an IndexNow submission alive after the response is sent. */
export async function handleCarrelRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | null> {
  const api = createSiteApi({
    adapter: carrelAdapter(getDb(env), {
      onLive: (slug) => scheduleIndexNow(request, ctx, [blogPostUrl(slug)]),
    }),
    key: env.CARREL_SITE_KEY,
    limiter: carrelLimiter(env),
  });
  if (!api.matches(request)) return null;
  return api.handle(request);
}
