import { redirect } from "react-router";

import { getAuth } from "~/lib/auth";
import { cloudflareContext } from "~/lib/cloudflare-context";

import type { Route } from "./+types/logout";

// Sign out on POST only (CSRF-safe); a stray GET just bounces to /login.
export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const res = await getAuth(env).api.signOut({
    headers: request.headers,
    asResponse: true,
  });

  const headers = new Headers();
  for (const cookie of res.headers.getSetCookie()) {
    headers.append("Set-Cookie", cookie);
  }
  return redirect("/login", { headers });
}

export function loader() {
  return redirect("/login");
}
