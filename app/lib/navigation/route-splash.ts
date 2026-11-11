/** Legacy's route loading splash, ported as a CAPABILITY per 292.
 *
 *  LEGACY'S SHAPE, read at blob 7466b69991de78e58ce75427611240723139bfe4 (366
 *  bytes) rather than from the scope doc's summary of it. It is NOT a skeleton:
 *  it is a full-height centered splash, the favicon at 96px over a mono
 *  "Loading..." on the page background.
 *
 *  LEGACY'S POPULATION, measured across its whole app tree rather than assumed
 *  from the one file the scope doc listed: EIGHT loading.tsx files exist, and
 *  every one is the SAME BLOB at the same 366 bytes. recovery/dashboard,
 *  recovery/payments, recovery/payments/[id], recovery/sequence, settings, and
 *  the three demo segments. So legacy's design is ONE app-wide splash, and the
 *  eight copies are an App Router constraint (a file per segment) rather than
 *  eight separate decisions.
 *
 *  THE MECHANISM DIFFERENCE. Next runs loading.tsx as a segment Suspense
 *  fallback. RR8 has no per-route loading file; its equivalent is the PERSISTENT
 *  PARENT rendering a fallback while a navigation is pending, which is what
 *  app-shell.tsx does around its Outlet. Same capability, different substrate,
 *  which is exactly what 292's semantic-port rule covers.
 *
 *  WHY formMethod IS CHECKED, read from the installed Navigation union and not
 *  assumed: the "loading" state carries
 *  `formMethod: Submission["formMethod"] | undefined`, so the REVALIDATION after
 *  a POST is also state "loading". Splashing on that would blank this page
 *  during every one of the five wired money actions (trigger, resend, stop,
 *  mark recovered, note save). A plain navigation is the one with NO formMethod,
 *  and that is the whole reason this predicate is not just a state check.
 *
 *  SCOPE IS NOW LEGACY'S WHOLE SET (306, which ruled the extension PARITY rather
 *  than divergence). 305 had bounded the build to the detail surface alone.
 *
 *  THE SET, mapped from the eight-blob scan rather than from memory. Legacy's
 *  eight segments collapse to FIVE Foxhound paths, and the collapse is the
 *  interesting part:
 *
 *    legacy recovery/dashboard        -> /recovery/dashboard  (reverted by J09)
 *    legacy recovery/payments         -> /recovery/payments
 *    legacy recovery/payments/[id]    -> /recovery/payments/:id
 *    legacy recovery/sequence         -> /recovery/sequence   (reverted by J09)
 *    legacy settings                  -> /settings
 *    legacy recovery/demo             -> /recovery/dashboard  (same path)
 *    legacy recovery/demo/payments    -> /recovery/payments   (same path)
 *    legacy recovery/demo/sequence    -> /recovery/sequence   (same path)
 *
 *  THREE of legacy's eight are DEMO duplicates, and Foxhound serves demo at the
 *  SAME paths as the real app rather than under a /demo prefix, so they need no
 *  entry of their own. Two of the remaining five sat at URLs Foxhound had not
 *  reverted (S5's /recovery for legacy's /recovery/dashboard, S9's
 *  /recovery/sequences for legacy's /recovery/sequence); J09 reverted both and
 *  the set moved with them.
 *
 *  WHAT IS DELIBERATELY EXCLUDED, because legacy has NO loading.tsx for it:
 *  /console, /disputes/dashboard, /intelligence/dashboard, /billing, /help, and the
 *  two NET-NEW recovery routes /recovery/winback and /recovery/expiring-cards.
 *  Legacy is the spec, and a splash where legacy shows none would be an invention.
 *
 *  ONE BOUND, stated rather than assumed. Next's loading.tsx is generally
 *  understood to wrap a segment AND its children, which would mean legacy also
 *  splashed /settings/team. That is framework semantics this repo cannot verify
 *  from an installed source, and the scan proves only WHICH FILES EXIST. So the
 *  set here is exactly the segments that HAVE a loading.tsx, and /settings/team
 *  is RAISED for a ruling rather than covered on an inference.
 */

/** The paths that splash. Capsomer's shouldShowRouteSplash
 *  (capsomer/behavior/route-splash) decides when (a plain navigation, never the
 *  revalidation after a post) and normalizes a trailing slash; this is only the
 *  app's own set. */

/** `/recovery/payments/:id` and nothing else under that prefix. The list itself
 *  is one segment shorter and has its own entry below, and export.csv is a
 *  resource route that returns a file rather than a page, so it never splashes. */
const PAYMENT_DETAIL_PATH = /^\/recovery\/payments\/(?!export\.csv$)[^/]+$/;

/** Legacy's remaining four segments, as Foxhound serves them. Exact paths, not
 *  prefixes: a prefix on /recovery would swallow winback and expiring-cards,
 *  which are NET-NEW and have no legacy loading.tsx to port. */
const SPLASH_PATHS: ReadonlySet<string> = new Set([
  "/recovery/dashboard",
  "/recovery/payments",
  "/recovery/sequence",
  "/settings",
]);

/** Every path legacy splashes, mapped onto Foxhound's routes. Capsomer passes
 *  the path with a trailing slash already removed. */
export function isSplashPath(pathname: string): boolean {
  return SPLASH_PATHS.has(pathname) || PAYMENT_DETAIL_PATH.test(pathname);
}
