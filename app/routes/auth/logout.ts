import { refuseCrossSite } from "@dustinedwards/site-runtime/origin";
import { redirect } from "react-router";

import { getAuth } from "~/lib/auth";
import { cloudflareContext } from "~/lib/cloudflare-context";

import type { Route } from "./+types/logout";

// Sign out on POST only (CSRF-safe); a stray GET just bounces to /login.
export async function action({ request, context }: Route.ActionArgs) {
  const refused = refuseCrossSite(request);
  if (refused) return refused;
  const { env } = context.get(cloudflareContext);
  const res = await (await getAuth(env)).api.signOut({
    headers: request.headers,
    asResponse: true,
  });

  // Better Auth's /sign-out clears the session cookies and, from site-runtime's
  // sign-out hook, sends Clear-Site-Data, OSHP's logout header: the browser also
  // drops this site's other cookies (theme, demo, view-as), its storage and its
  // cache. Both go onto the redirect.
  const headers = new Headers(res.headers);
  headers.delete("Content-Type");
  headers.delete("Content-Length");
  return redirect("/login", { headers });
}

export function loader() {
  return redirect("/login");
}
