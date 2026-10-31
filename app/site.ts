import { startIslands } from "@dustinedwards/devkit/islands";

// The one script a public marketing page runs, /site.js (devkit's siteScript in vite.config.ts). Those pages
// send no React: root.tsx renders <Scripts/> only on a route whose handle says `hydrate: true`, and on those
// pages /site.js is left out, so React and an island never wire the same markup twice. It starts every
// [data-island] element on the page, importing that island's content-hashed module from /islands/.
startIslands();
