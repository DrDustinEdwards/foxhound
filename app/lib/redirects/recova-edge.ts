// RECOVA'S OLD ADDRESSES, ANSWERED (CUTOVER-PLAN.md step 4, ruling 408).
//
// workers/app.ts calls this first on every request. For any host outside
// RECOVA_MAP_HOSTS it returns null and costs one Set lookup, so it is inert
// until the cutover attaches recovamrr.com, www.recovamrr.com and
// app.recovamrr.com to this Worker. From then on each Recova address answers
// ONE 301 to its foxhoundapp.com address, so the search ranking those
// addresses earned moves with them.
//
// Matching order, most specific first: a fixed path ("/pricing",
// "/blog/recova-vs-churnkey"), then a dynamic one ("/blog/:slug"), then a
// "/:path*" prefix ("/user-guides/:path*"). A path the map does not name keeps
// its path on the new domain, where Foxhound answers it (a page, a 404, or the
// 410 of a withdrawn post) rather than every stray address being dumped on the
// home page, which Google reads as a soft 404 (ruling 408 binding 4).
//
// The Location is always SITE_ORIGIN plus a path rebuilt from the request's
// own non-empty segments, already percent-encoded by URL parsing, so no request
// can point it at another host.

import { SITE_ORIGIN } from "~/lib/seo/jsonld";

import type { RedirectMapEntry } from "./derive-recova-map";
import { RECOVA_MAP_HOSTS, RECOVA_REDIRECT_MAP } from "./recova-map";

const HOSTS = new Set(RECOVA_MAP_HOSTS);
const SPLAT = "/:path*";

interface Pattern {
  segments: string[];
  splat: boolean;
  to: string;
}

function split(path: string): string[] {
  return path.split("/").filter((segment) => segment !== "");
}

function toPattern(entry: RedirectMapEntry): Pattern {
  const splat = entry.from.endsWith(SPLAT);
  return { segments: split(splat ? entry.from.slice(0, -SPLAT.length) : entry.from), splat, to: entry.to };
}

const isDynamic = (p: Pattern) => p.segments.some((s) => s.startsWith(":"));
const PATTERNS = RECOVA_REDIRECT_MAP.map(toPattern);
const ORDERED = [
  ...PATTERNS.filter((p) => !p.splat && !isDynamic(p)),
  ...PATTERNS.filter((p) => !p.splat && isDynamic(p)),
  ...PATTERNS.filter((p) => p.splat),
];

function decoded(segment: string): string {
  try {
    return decodeURIComponent(segment).toLowerCase();
  } catch {
    return segment.toLowerCase();
  }
}

/** The Foxhound path for a request's segments under one pattern, or null. */
function apply(pattern: Pattern, segments: string[]): string | null {
  const n = pattern.segments.length;
  if (pattern.splat ? segments.length < n : segments.length !== n) return null;
  const captured: string[] = [];
  for (let i = 0; i < n; i++) {
    const want = pattern.segments[i]!;
    if (want.startsWith(":")) captured.push(segments[i]!);
    else if (decoded(segments[i]!) !== want) return null;
  }
  const target = split(pattern.splat ? pattern.to.slice(0, -SPLAT.length) : pattern.to).map((segment) =>
    segment.startsWith(":") ? captured.shift()! : segment,
  );
  if (pattern.splat) target.push(...segments.slice(n));
  return `/${target.join("/")}`;
}

/** Where a request on a Recova host belongs on foxhoundapp.com, or null when
 *  the request is not on a Recova host. */
export function recovaRedirectLocation(requestUrl: string): string | null {
  const url = new URL(requestUrl);
  if (!HOSTS.has(url.hostname.toLowerCase())) return null;
  const segments = split(url.pathname);
  let path = `/${segments.join("/")}`;
  for (const pattern of ORDERED) {
    const mapped = apply(pattern, segments);
    if (mapped) {
      path = mapped;
      break;
    }
  }
  return `${SITE_ORIGIN}${path}${url.search}`;
}

/** The 301 for a request on a Recova host, or null for every other request. */
export function recovaRedirect(request: Request): Response | null {
  const location = recovaRedirectLocation(request.url);
  if (!location) return null;
  return new Response(null, { status: 301, headers: { Location: location } });
}
