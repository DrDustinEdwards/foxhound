import { Alert } from "capsomer/react/banner";
import { Button } from "capsomer/react/button";
import { data } from "react-router";

import { AuthCard, AuthFootnote, AuthHeading, AuthLink } from "~/components/auth-card";
import { getAuth } from "~/lib/auth";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { NOINDEX } from "~/lib/seo/meta";

import type { Route } from "./+types/email-confirm";

// /email/confirm, where both email-change links open (send-auth-email.ts's
// emailChangeConfirmURL). Its GET only shows this card, so a mail scanner that
// opens every link confirms nothing; the button's POST runs Better Auth's
// verify-email with the token, which mails the new address (step
// "confirmed") or makes the change (step "changed"), then lands on
// /settings/account, which says which. A spent or expired link lands there too,
// with ?error=.

export function meta() {
  return [{ title: "Confirm your email change - Foxhound" }, NOINDEX];
}

// The page's URL holds the token.
export const headers = () => ({ "Cache-Control": "no-store" });

function readStep(value: string | null): "confirmed" | "changed" | null {
  return value === "confirmed" || value === "changed" ? value : null;
}

export function loader({ request }: Route.LoaderArgs) {
  const params = new URL(request.url).searchParams;
  const step = readStep(params.get("step"));
  return { valid: Boolean(params.get("token")) && step !== null, step };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const params = new URL(request.url).searchParams;
  const token = params.get("token");
  const step = readStep(params.get("step"));
  if (!token || !step) return data({ failed: true }, { status: 400 });
  // Better Auth answers with a redirect to callbackURL (with ?error= when the
  // token is spent or expired) and, on the change itself, the session cookie.
  return (await getAuth(env)).api.verifyEmail({
    query: { token, callbackURL: `/settings/account?email=${step}` },
    headers: request.headers,
    asResponse: true,
  });
}

export default function EmailConfirm({ loaderData, actionData }: Route.ComponentProps) {
  if (!loaderData.valid || actionData?.failed) {
    return (
      <AuthCard>
        <AuthHeading title="This link does not work" />
        <Alert tone="crit">Open the newest email-change link we sent, or start the change again.</Alert>
        <AuthFootnote>
          <AuthLink to="/settings/account">Account settings</AuthLink>
        </AuthFootnote>
      </AuthCard>
    );
  }
  const first = loaderData.step === "confirmed";
  return (
    <AuthCard>
      <AuthHeading
        title={first ? "Confirm the email change" : "Confirm your new email address"}
        subtitle={
          first
            ? "We then send a link to the new address to finish the change."
            : "Your Foxhound sign-in moves to this address, and your other devices are signed out."
        }
      />
      {/* A plain form: it posts to this URL, token and all, and the browser follows the redirect. */}
      <form method="post" className="grid gap-3">
        <Button type="submit" variant="primary" size="lg">
          {first ? "Confirm the change" : "Confirm email address"}
        </Button>
      </form>
    </AuthCard>
  );
}
