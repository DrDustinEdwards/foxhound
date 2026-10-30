// RECOVA'S SEVEN CONFIG-LEVEL REDIRECTS (J23, ledger row F17).
//
// Transcribed from the `redirects()` block of Recova's next.config.ts
// (DrDustinEdwards/recova, blob 8cf9b0c72fe9bdfa26340dd65283a3a7a9fceb8d,
// 5541 bytes), in Recova's order, with Recova's source and destination
// patterns unchanged. This is the spec, not the redirect map: the map in
// recova-map.ts is still generated, and its generator reads
// this table so that recovamrr.com/user-guides goes to foxhoundapp.com/docs in
// ONE hop instead of landing on a Foxhound path that redirects again.
//
// Every destination is a fixed path on this site. The only part of a request
// that reaches a Location header is the remainder under a `/:path*` prefix,
// re-encoded segment by segment beneath that fixed prefix, so no request can
// point a redirect at another origin.

export interface RecovaConfigRedirect {
  /** Recova's `source`, verbatim. */
  source: string;
  /** Recova's `destination`, verbatim. */
  destination: string;
  /** Recova's `permanent`. Next.js answers true with 308 and false with 307. */
  permanent: boolean;
  /** Recova's `has: [{ type: "host", value }]`, when the rule is host-scoped. */
  host?: string;
}

export const RECOVA_CONFIG_REDIRECTS: readonly RecovaConfigRedirect[] = [
  { source: "/recovery/audit", destination: "/audit", permanent: true },
  { source: "/recovery/audit/connect", destination: "/audit/connect", permanent: true },
  { source: "/recovery/audit/results", destination: "/audit/results", permanent: true },
  { source: "/:path*", destination: "https://recovamrr.com/:path*", permanent: true, host: "app.recovamrr.com" },
  { source: "/user-guides/:path*", destination: "/docs/:path*", permanent: true },
  { source: "/user-guides", destination: "/docs", permanent: true },
  { source: "/sitemap_index.xml", destination: "/sitemap.xml", permanent: true },
];

export interface ResolvedRedirect {
  location: string;
  status: 307 | 308;
}

const PATH_SPLAT = "/:path*";

/** The path's segments as React Router matches them: each one
 *  percent-decoded on its own (one that will not decode is kept as sent), so
 *  an encoded "/" stays inside its segment, with empty segments (doubled and
 *  trailing slashes) dropped. */
function decodedSegments(pathname: string): string[] {
  return pathname
    .split("/")
    .filter((segment) => segment !== "")
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
}

/** Where Foxhound sends `pathname` (raw, as in URL.pathname) under Recova's
 *  path rules, or null when no rule matches. Host-scoped rules are skipped:
 *  Foxhound serves no app.* host, and the cutover map carries that rule. The
 *  match is case-insensitive and ignores a trailing slash, as the router's is,
 *  so a path the router sends here always resolves.
 *
 *  Under a `/:path*` rule the remainder is re-encoded one segment at a time
 *  beneath the rule's fixed prefix, and "." and ".." segments are dropped, so
 *  no request can climb out of that prefix or start a protocol-relative or
 *  absolute Location. */
export function resolveRecovaConfigRedirect(pathname: string, search = ""): ResolvedRedirect | null {
  const segments = decodedSegments(pathname);
  const lower = segments.map((segment) => segment.toLowerCase());
  for (const rule of RECOVA_CONFIG_REDIRECTS) {
    if (rule.host) continue;
    const status = rule.permanent ? 308 : 307;
    const splat = rule.source.endsWith(PATH_SPLAT);
    const fixed = decodedSegments(splat ? rule.source.slice(0, -PATH_SPLAT.length) : rule.source);
    if (splat ? lower.length < fixed.length : lower.length !== fixed.length) continue;
    if (!fixed.every((segment, i) => segment.toLowerCase() === lower[i])) continue;
    if (!splat) return { location: `${rule.destination}${search}`, status };
    const base = rule.destination.slice(0, -PATH_SPLAT.length);
    const rest = segments
      .slice(fixed.length)
      .filter((segment) => segment !== "." && segment !== "..")
      .map((segment) => encodeURIComponent(segment));
    return { location: `${[base, ...rest].join("/")}${search}`, status };
  }
  return null;
}
