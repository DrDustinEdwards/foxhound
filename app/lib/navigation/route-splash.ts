/**
 * THE MECHANISM DIFFERENCE. Next runs loading.tsx as a segment Suspense fallback. Splashing on that
 * would blank this page during every one of the five wired money actions (trigger, resend, stop,
 * mark recovered, note save).
 */

/** The paths that splash. Capsomer's shouldShowRouteSplash
 *  (capsomer/behavior/route-splash) decides when (a plain navigation, never the
 *  revalidation after a post) and normalizes a trailing slash; this is only the
 *  app's own set. */

/** `/recovery/payments/:id` and nothing else under that prefix. The list itself
 *  is one segment shorter and has its own entry below, and export.csv is a
 *  resource route that returns a file rather than a page, so it never splashes. */
const PAYMENT_DETAIL_PATH = /^\/recovery\/payments\/(?!export\.csv$)[^/]+$/;

const SPLASH_PATHS: ReadonlySet<string> = new Set([
  "/recovery/dashboard",
  "/recovery/payments",
  "/recovery/sequence",
  "/settings",
]);

/** Capsomer passes the path with a trailing slash already removed. */
export function isSplashPath(pathname: string): boolean {
  return SPLASH_PATHS.has(pathname) || PAYMENT_DETAIL_PATH.test(pathname);
}
