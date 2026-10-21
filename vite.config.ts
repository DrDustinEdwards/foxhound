import { reactRouter } from "@react-router/dev/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
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
  ],
});
