import { webManifest } from "@drdustinedwards/site-helpers/icons";

export function loader() {
  const manifest = webManifest({ name: "Foxhound", themeColor: "#f0b429", backgroundColor: "#111210" });
  return new Response(JSON.stringify(manifest), {
    headers: { "Content-Type": "application/manifest+json", "Cache-Control": "public, max-age=86400" },
  });
}
