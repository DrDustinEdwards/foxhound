import { confirmSignInLink } from "@dustinedwards/site-runtime/sign-in";
import { Button } from "capsomer/react/button";
import { Form } from "react-router";

import { AuthCard, AuthHeading } from "~/components/auth-card";
import { getAuth } from "~/lib/auth";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { NOINDEX } from "~/lib/seo/meta";

import type { Route } from "./+types/sign-in-confirm";

// /sign-in/confirm, where the emailed sign-in link opens (site-runtime ./sign-in, since 0.36.0): a GET only shows the
// button, so a mail scanner that opens every link neither spends it nor signs itself in. The button's POST, to this
// URL with its query, runs Better Auth's verify through confirmSignInLink and returns its answer untouched.

export function meta() {
  return [{ title: "Sign in - Foxhound" }, NOINDEX];
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  return confirmSignInLink(await getAuth(env), request);
}

export default function SignInConfirm() {
  return (
    <AuthCard>
      <AuthHeading title="Sign in to Foxhound" />
      <Form method="post" reloadDocument className="grid">
        <Button type="submit" variant="primary" size="lg">
          Sign in
        </Button>
      </Form>
    </AuthCard>
  );
}
