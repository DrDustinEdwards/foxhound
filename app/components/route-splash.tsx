/** Legacy's loading splash, read at blob 7466b69991de78e58ce75427611240723139bfe4
 *  (366 bytes) and ported element for element. Legacy's markup is a centred
 *  column: the favicon at 96 square with mb-6, then "Loading..." in mono.
 *
 *  THREE DIFFERENCES, each with its class named rather than glossed:
 *
 *  1. `next/image` becomes a plain `<img>` at the same intrinsic 96x96. Next's
 *     Image is a framework optimiser with no RR8 counterpart; the rendered box
 *     is identical. Internals-only, invisible to the user.
 *  2. alt "Recova" becomes "Foxhound". Branding, which needs no per-item
 *     ratification.
 *  3. legacy's arbitrary `text-[0.8125rem]` becomes the `text-label` token,
 *     which app.css defines as exactly 0.8125rem. A RESOLVED-VALUE MATCH in the
 *     sense 147 records, the same shape as py-3.5 against py-[14px]: identical
 *     rendered size, and the token is used because conventions prefer it over a
 *     minted arbitrary value.
 *
 *  The image is /favicon.svg, not /favicon.png: the PNG favicon is 32 square
 *  since the hound mark (job_afa3591dac7e), and 32 drawn at 96 would blur. The
 *  SVG is the same icon at any size.
 *
 *  RAISED, NOT BUILT (190), AND STILL PENDING AFTER 306: legacy announces
 *  nothing to assistive technology here, no role="status" and no aria-live, so a
 *  screen reader user gets silence during the pause. 306 put the question to
 *  Dustin and carried an explicit instruction not to add it unratified; no
 *  ratification arrived with that brief, so it stays unbuilt and the splash now
 *  renders silently on FIVE paths rather than one, which widens the gap without
 *  changing its character. Adding it is a ruling, not an agent's initiative.
 */
export function RouteSplash() {
  return (
    <div className="min-h-screen bg-bg flex flex-col items-center justify-center">
      <img src="/favicon.svg" alt="Foxhound" width={96} height={96} className="mb-6" />
      <div className="text-text-subtle font-mono text-label tracking-wider">Loading...</div>
    </div>
  );
}
