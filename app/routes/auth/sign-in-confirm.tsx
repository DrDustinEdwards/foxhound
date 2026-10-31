import { confirmSignInLink } from "@dustinedwards/site-runtime/sign-in";
import { Button } from "capsomer/react/button";

import { AuthCard, AuthHeading } from "~/components/auth-card";
import { getAuth } from "~/lib/auth";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { NOINDEX } from "~/lib/seo/meta";

import type { Route } from "./+types/sign-in-confirm";

// /sign-in/confirm, the page the mailed sign-in link opens (site-runtime 0.36
// ./sign-in, CONFIRM_PATH). A GET only shows the button, so a mail scanner that
// opens every link neither spends the link nor signs itself in; the button's
// POST runs Better Auth's verify through confirmSignInLink, which answers its
// 302 to the link's callbackURL (the passkey offer) with the session cookie.
// The URL holds the token: never stored, never indexed, nothing loaded from
// another origin.

export function meta() {
  return [{ title: "Sign in - Foxhound" }, NOINDEX];
}

export function headers() {
  return { "Cache-Control": "no-store, no-cache, must-revalidate, private" };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  return confirmSignInLink(await getAuth(env), request);
}

export default function SignInConfirm() {
  return (
    <AuthCard>
      <AuthHeading title="Sign in to Foxhound" subtitle="Press the button to finish signing in on this device." />
      {/* A plain form: it posts to this page's own URL, query and all, with or without scripts. */}
      <form method="post">
        <Button type="submit" variant="primary" size="lg">
          Sign in to Foxhound
        </Button>
      </form>
    </AuthCard>
  );
}
