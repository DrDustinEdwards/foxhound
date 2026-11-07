/**
 * The paths a public page links to that need a session or start one: Connect, the signed-in product pages and the demo
 * entries, which set the demo cookie and redirect. robots.txt keeps crawlers off them, and a link to one says
 * `rel="nofollow"`, so a crawler is not sent down a redirect to the login page. A reader clicks them as usual.
 */
const APP_PREFIXES = ["/demos/", "/recovery/", "/disputes/", "/intelligence/"];
const APP_PATHS = new Set(["/connect", "/audit/dashboard"]);

/** `"nofollow"` for a link to an app path, else nothing. */
export function appLinkRel(path: string): "nofollow" | undefined {
  const bare = path.split(/[?#]/)[0] ?? path;
  return APP_PATHS.has(bare) || APP_PREFIXES.some((prefix) => bare.startsWith(prefix))
    ? "nofollow"
    : undefined;
}
