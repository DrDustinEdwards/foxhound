// RECOVA'S SEVEN CONFIG-LEVEL REDIRECTS (J23, ledger row F17).
//
// Transcribed from the `redirects()` block of Recova's next.config.ts
// (DrDustinEdwards/recova, blob 8cf9b0c72fe9bdfa26340dd65283a3a7a9fceb8d,
// 5541 bytes), in Recova's order, with Recova's source and destination
// patterns unchanged. Foxhound itself serves none of these (it has no internal
// redirects, Dustin 2026-11-11); the generator of the cutover map in
// recova-map.ts reads this table so that recovamrr.com/user-guides goes to
// foxhoundapp.com/docs in one hop.

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
  {
    source: "/:path*",
    destination: "https://recovamrr.com/:path*",
    permanent: true,
    host: "app.recovamrr.com",
  },
  { source: "/user-guides/:path*", destination: "/docs/:path*", permanent: true },
  { source: "/user-guides", destination: "/docs", permanent: true },
  { source: "/sitemap_index.xml", destination: "/sitemap.xml", permanent: true },
];
