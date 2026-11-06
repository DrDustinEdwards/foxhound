import { reactRouter } from "@react-router/dev/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { siteScript } from "@dustinedwards/devkit/vite/site-script";
import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  // The Worker bundle (wrangler deploys it unbundled, so wrangler's own minify
  // does not apply): minified, names kept for stack traces and
  // err.constructor.name, with source maps for wrangler to upload.
  environments: {
    ssr: {
      build: { minify: true, sourcemap: true, rolldownOptions: { output: { keepNames: true } } },
    },
  },
  plugins: [
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tailwindcss(),
    reactRouter(),
    // /site.js and the islands it starts (app/site.ts, app/islands/*.ts): the only script a public
    // marketing page runs. A page that hydrates (`handle = { hydrate: true }`, root.tsx) gets React instead.
    siteScript({ toolbar: false }),
  ],
});
