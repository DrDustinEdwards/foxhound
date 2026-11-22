// RECOVA'S SEVEN CONFIG-LEVEL REDIRECTS.

export interface RecovaConfigRedirect {
  source: string;
  destination: string;
  permanent: boolean;
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
