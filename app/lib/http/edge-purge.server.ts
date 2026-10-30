// Purging the stored public pages (site-runtime ./edge-cache) from code that
// has no execution context: the blog-schedules cron and the five-minute ticker
// apply schedules through site-api with only `env` in hand.
//
// A purge is scoped to the entrypoint that calls it, and the pages are stored
// by the Renderer, so the purge must run INSIDE the Renderer
// (developers.cloudflare.com/workers/cache/purge/, "Purge modes"): this asks it
// to, over the Worker's own loopback (`exports` from "cloudflare:workers").
// Imported when called, not at the top, so the Node test runner, which has no
// such module, never loads it. Never throws: a failed purge is a stale page
// until it expires (a day) and a log line, not a failed publish.

export async function purgePublicPages(why: string): Promise<boolean | null> {
  try {
    const { exports } = await import("cloudflare:workers");
    return await exports.Renderer.purgePages(why);
  } catch (error) {
    console.error(JSON.stringify({ alert: "cache-purge-unreachable", why, detail: String(error) }));
    return null;
  }
}
