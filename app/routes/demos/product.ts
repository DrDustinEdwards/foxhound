import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import { enterDemo, isDemoEntryProduct } from "~/lib/marketing/demo-entry.server";

import type { Route } from "./+types/product";

// A real GET link into the demo (/demos/recovery and the rest): a crawler, a bookmark, or a plain <a> all reach it.
// Only the products demo-entry.server.ts lists answer; any other name is a 404.
export async function loader({ params, context }: Route.LoaderArgs) {
  if (!isDemoEntryProduct(params.product)) throw new Response("Not Found", { status: 404 });
  const { env } = context.get(cloudflareContext);
  return enterDemo(env, params.product);
}
