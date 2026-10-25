import { aiTxt } from "@drdustinedwards/site-helpers/robots";

import { cloudflareContext } from "~/lib/cloudflare-context";
import { SUPPORT_EMAIL, siteUrl } from "~/lib/seo/jsonld";

import { DISALLOW_PATHS } from "./robots";
import type { Route } from "./+types/ai-txt";

// /ai.txt, the family's AI usage policy from Prelum: answer engines may cite and
// link, training rights are reserved (the TDMRep header in
// app/lib/http/header-set.ts says the same) and licensed through support. The
// disallow list is robots.txt's.
export function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const body = aiTxt({ origin: siteUrl(env), name: "Foxhound", contact: SUPPORT_EMAIL, disallow: DISALLOW_PATHS });
  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=86400",
    },
  });
}
