/** Legacy's route loading splash, ported as a CAPABILITY per 292 (ruling 305).
 *
 *  LEGACY'S SHAPE, read at blob 7466b69991de78e58ce75427611240723139bfe4 (366
 *  bytes) rather than from the scope doc's summary of it. It is NOT a skeleton:
 *  it is a full-height centred splash, the favicon at 96px over a mono
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
 *  SCOPE IS DELIBERATELY NARROWER THAN LEGACY'S. 305 bounds the build to the
 *  detail surface, so only the payment detail path splashes here. Legacy
 *  splashes on seven further segments with the identical file; extending to
 *  them is a change to this ONE predicate and is a ruling, not an agent's
 *  default.
 */

/** The shape this predicate needs from RR's `Navigation`, narrowed so the
 *  decision is testable without a DOM or a router. */
export type SplashNavigation = {
  state: "idle" | "loading" | "submitting";
  formMethod?: string | undefined;
  location?: { pathname: string } | undefined;
};

/** `/recovery/payments/:id` and nothing else under that prefix. The list itself
 *  is one segment shorter, and export.csv is a resource route that returns a
 *  file rather than a page, so neither may splash. */
const PAYMENT_DETAIL_PATH = /^\/recovery\/payments\/(?!export\.csv$)[^/]+$/;

export function isPaymentDetailPath(pathname: string): boolean {
  return PAYMENT_DETAIL_PATH.test(pathname);
}

export function shouldShowRouteSplash(navigation: SplashNavigation): boolean {
  // Settled: whatever is on screen is the answer, never a splash.
  if (navigation.state !== "loading") return false;
  // Post-submission revalidation, not a navigation. See the header note.
  if (navigation.formMethod != null) return false;
  const pathname = navigation.location?.pathname;
  return pathname != null && isPaymentDetailPath(pathname);
}
