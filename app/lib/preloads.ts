import { preloads } from "@dustinedwards/site-runtime/preload";

import dmMono400 from "capsomer/fonts/dm-mono-400.woff2?url";
import dmMono500 from "capsomer/fonts/dm-mono-500.woff2?url";
import dmSansVariable from "capsomer/fonts/dm-sans-variable.woff2?url";

// Every page's font preloads (Capsomer's files, the ones capsomer/fonts-dm-sans.css and fonts-dm-mono.css name), declared once: root.tsx's `links`, and with the
// root stylesheets the `Link` header workers/app.ts adds to HTML responses,
// which Cloudflare Early Hints sends ahead as a 103. site-runtime adds the
// `crossorigin` a font preload needs, or the file is fetched twice.
export const FONT_PRELOADS = [
  { href: dmSansVariable, as: "font", type: "font/woff2" },
  { href: dmMono400, as: "font", type: "font/woff2" },
  { href: dmMono500, as: "font", type: "font/woff2" },
] as const;

export const PRELOADS = preloads([...FONT_PRELOADS]);
