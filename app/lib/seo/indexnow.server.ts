import { submitIndexNow } from "@drdustinedwards/site-helpers/indexnow";
import { indexNowHook } from "@dustinedwards/site-api";

import { INDEXNOW_KEY } from "./indexnow-key";

// IndexNow submissions (job_b0b24df12155, row F20). Recova is the spec
// (lib/indexnow.ts in the legacy repo): when a blog post is saved and is
// published after the save, POST that post's one URL to api.indexnow.org so
// Bing, Yandex and the other IndexNow engines crawl it now rather than on their
// next sweep. Errors are swallowed: a missed ping only means the engine finds
// the URL on its own schedule, which is the baseline.
//
// The submission is the family's: site-api's indexNowHook over Prelum's
// submitIndexNow. The Carrel mount (app/lib/carrel/handler.server.ts) passes
// the hook to site-api, which runs it after a Carrel write and after each
// schedule the cron applies; the /admin/blog editor calls notifyIndexNow below.
//
// Foxhound differs from Recova in three ways:
// 1. Its own key (indexnow-key.ts), never Recova's key or filename. Dustin's
//    ruling, Q15, 2026-10-14: "new key".
// 2. Recova skips when INDEXNOW_KEY is unset, which is how its dev and preview
//    builds stay quiet. Foxhound's env cannot tell dev or a preview from
//    production (wrangler.jsonc sets BETTER_AUTH_URL to https://foxhoundapp.com
//    everywhere), so the guard is the origin of the REQUEST that made the
//    change, which the hook checks: only a publish arriving on
//    https://foxhoundapp.com submits. A schedule has no request and always
//    submits, since only the production cron applies one.
// 3. On Workers a promise nobody awaits can be cut off once the response is
//    sent, so the submission is handed to ctx.waitUntil. The publish never
//    waits on it.
// 2 and 3 are internals the Cloudflare-native stack needs and the user never
// sees, the prime directive's first category that needs no per-item approval.

const INDEXNOW_ORIGIN = "https://foxhoundapp.com";

export const indexNow = indexNowHook({ submit: submitIndexNow, origin: INDEXNOW_ORIGIN, key: INDEXNOW_KEY });

/**
 * The /admin/blog editor's submission of one post, after a save or publish that
 * leaves it live. Fire and forget: kept alive by ctx.waitUntil, never awaited,
 * and never the caller's failure.
 */
export function notifyIndexNow(request: Request, ctx: ExecutionContext, post: { id: string; slug: string }): void {
  try {
    const path = `/blog/${post.slug}`;
    const sent = indexNow.run({
      action: "update",
      id: post.id,
      path,
      url: `${INDEXNOW_ORIGIN}${path}`,
      trigger: "request",
      changeId: null,
      request,
    });
    ctx.waitUntil(Promise.resolve(sent).catch(() => false));
  } catch {
    // A failure to schedule is the same as a missed ping: never the caller's.
  }
}
