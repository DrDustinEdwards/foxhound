import { preloads } from "@dustinedwards/site-runtime/preload";

import dmMono400 from "../assets/fonts/dm-mono-400.woff2?url";
import dmMono500 from "../assets/fonts/dm-mono-500.woff2?url";
import dmSansVariable from "../assets/fonts/dm-sans-variable.woff2?url";

// Every page's preloads, declared once: root.tsx's `links` and the `Link` header
// workers/app.ts adds to HTML responses, which Cloudflare Early Hints sends ahead
// as a 103. site-runtime adds the `crossorigin` a font preload needs, or the
// file is fetched twice.
export const PRELOADS = preloads([
  { href: dmSansVariable, as: "font", type: "font/woff2" },
  { href: dmMono400, as: "font", type: "font/woff2" },
  { href: dmMono500, as: "font", type: "font/woff2" },
]);
