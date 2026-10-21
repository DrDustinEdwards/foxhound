import { INDEXNOW_KEY, INDEXNOW_KEY_PATH } from "./indexnow-key";

// IndexNow submissions (job_b0b24df12155, row F20). Recova is the spec
// (lib/indexnow.ts in the legacy repo): when a blog post is saved and is
// published after the save, POST that post's one URL to api.indexnow.org so
// Bing, Yandex and the other IndexNow engines crawl it now rather than on their
// next sweep. Errors are swallowed: a missed ping only means the engine finds
// the URL on its own schedule, which is the baseline.
//
// Foxhound differs from Recova in three ways:
// 1. Its own key (indexnow-key.ts), never Recova's key or filename. Dustin's
//    ruling, Q15, 2026-10-14: "new key".
// 2. Recova skips when INDEXNOW_KEY is unset, which is how its dev and preview
//    builds stay quiet. Foxhound's key is a committed constant, and its env
//    cannot tell dev or a preview from production (wrangler.jsonc sets
//    BETTER_AUTH_URL to https://foxhoundapp.com everywhere), so the guard is
//    the origin of the REQUEST that made the change: only a publish arriving on
//    https://foxhoundapp.com submits. A localhost or *.workers.dev request
//    never pings the engine.
// 3. On Workers a promise nobody awaits can be cut off once the response is
//    sent, so the submission is handed to ctx.waitUntil. The publish never
//    waits on it.
// 2 and 3 are internals the Cloudflare-native stack needs and the user never
// sees, the prime directive's first category that needs no per-item approval.
//
// WHERE THE HOOKS LIVE TODAY: the Carrel adapter (app/lib/carrel/adapter.server.ts)
// and the /admin/blog editor (app/routes/admin/blog/detail.tsx). They move when
// Carrel takes over blog publishing (J11, job_09c55603e321) and Prelum serves
// the blog pages (J19 job_deffd581af37, J61 job_2ee0cfdd5c29).

const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";
const INDEXNOW_HOST = "foxhoundapp.com";
const INDEXNOW_ORIGIN = `https://${INDEXNOW_HOST}`;
const INDEXNOW_KEY_LOCATION = `${INDEXNOW_ORIGIN}${INDEXNOW_KEY_PATH}`;

/** The public URL of a blog post, the one URL Recova submits per save. */
export function blogPostUrl(slug: string): string {
  return `${INDEXNOW_ORIGIN}/blog/${slug}`;
}

/** Only Foxhound's own URLs: IndexNow refuses a urlList outside `host`. */
function ownUrls(urls: string[]): string[] {
  return urls.filter((url) => url.startsWith(`${INDEXNOW_ORIGIN}/`));
}

/**
 * POST the URLs to IndexNow. NEVER THROWS: a network error and a non-2xx answer
 * both resolve to false, so a caller that does not await it can never see a
 * rejection. A no-op (false) on an empty list.
 */
export async function submitToIndexNow(urls: string[]): Promise<boolean> {
  const urlList = ownUrls(urls);
  if (urlList.length === 0) return false;
  try {
    const response = await fetch(INDEXNOW_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        host: INDEXNOW_HOST,
        key: INDEXNOW_KEY,
        keyLocation: INDEXNOW_KEY_LOCATION,
        urlList,
      }),
    });
    return response.ok;
  } catch {
    // Intentionally swallowed: see the header comment.
    return false;
  }
}

/**
 * Fire and forget. Starts the submission without waiting for it and keeps the
 * Worker alive for it through ctx.waitUntil. Does nothing at all unless the
 * request that made the change arrived on https://foxhoundapp.com.
 */
export function scheduleIndexNow(request: Request, ctx: ExecutionContext, urls: string[]): void {
  try {
    if (new URL(request.url).origin !== INDEXNOW_ORIGIN) return;
    const pending = submitToIndexNow(urls);
    ctx.waitUntil(pending);
  } catch {
    // A failure to schedule is the same as a missed ping: never the caller's.
  }
}
