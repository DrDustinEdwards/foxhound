import { confirmSignInLink } from "@dustinedwards/site-runtime/sign-in";
import { Button } from "capsomer/react/button";

import { AuthCard, AuthHeading } from "~/components/auth-card";
import { getAuth } from "~/lib/auth";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { NOINDEX } from "~/lib/seo/meta";

import type { Route } from "./+types/sign-in-confirm";

// Where an emailed sign-in link opens (site-runtime ./sign-in, CONFIRM_PATH):
// a GET signs nobody in, so a mail scanner that opens the link cannot spend
// it. The button posts back to this URL, query and all, and confirmSignInLink
// runs Better Auth's verify, answering its redirect and session cookie.
export function meta() {
  return [{ title: "Sign in to Foxhound" }, NOINDEX];
}

export const headers = () => ({ "Cache-Control": "no-store" });

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  return confirmSignInLink(await getAuth(env), request);
}

export default function SignInConfirm() {
  return (
    <AuthCard>
      <AuthHeading title="Sign in to Foxhound" subtitle="Press the button to finish signing in on this device." />
      {/* A native post, so the page's own URL (the link's token) goes with it. */}
      <form method="post">
        <Button type="submit" variant="primary" size="lg">
          Sign in to Foxhound
        </Button>
      </form>
    </AuthCard>
  );
}
