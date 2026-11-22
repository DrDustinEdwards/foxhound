/** The paths a public page links to that need a session or start one: Connect, the signed-in product pages and the demo entries (which
 *  set the demo cookie and redirect). robots.txt keeps crawlers off them and a link to one says `rel="nofollow"`. */
const APP_PREFIXES = ["/demos/", "/recovery/", "/disputes/", "/intelligence/"];
const APP_PATHS = new Set(["/connect", "/audit/dashboard"]);

export function appLinkRel(path: string): "nofollow" | undefined {
  const bare = path.split(/[?#]/)[0] ?? path;
  return APP_PATHS.has(bare) || APP_PREFIXES.some((prefix) => bare.startsWith(prefix))
    ? "nofollow"
    : undefined;
}
