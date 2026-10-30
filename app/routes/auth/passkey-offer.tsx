import { Alert } from "capsomer/react/banner";
import { Button } from "capsomer/react/button";
import { useState } from "react";
import { redirect } from "react-router";

import { AuthCard, AuthFootnote, AuthHeading, AuthLink } from "~/components/auth-card";
import { getAuth } from "~/lib/auth";
import { authClient } from "~/lib/auth/client";
import { signedInLanding } from "~/lib/auth/landing.server";
import { safeNextPath } from "~/lib/auth/next-path";
import { cloudflareContext } from "~/lib/cloudflare-context";

import type { Route } from "./+types/passkey-offer";
import { NOINDEX } from "~/lib/seo/meta";

// /passkey, where an emailed sign-in link lands (app/lib/auth/sign-in-link.server.ts):
// it offers a passkey, so the next sign-in has no email to wait for, and goes
// on to `next`. Someone who already has one goes straight on. Foxhound's own
// page, as the family sign-in has it (Foxing's passkey-offer.tsx; site-runtime
// ./sign-in), in the sign-in card.

export function meta() {
  return [{ title: "Add a passkey - Foxhound" }, NOINDEX];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = await getAuth(env);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) throw redirect("/login");
  // Settled here, once signed in: an account not yet on Stripe goes on to
  // /connect rather than an empty console.
  const next = await signedInLanding(env, session, safeNextPath(new URL(request.url).searchParams.get("next")));
  const passkeys = await auth.api.listPasskeys({ headers: request.headers });
  if (passkeys.length > 0) throw redirect(next);
  return { next };
}

export default function PasskeyOffer({ loaderData }: Route.ComponentProps) {
  const { next } = loaderData;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <AuthCard>
      <AuthHeading
        title="You're signed in"
        subtitle="Next time, skip the email. A passkey signs you in with your face, fingerprint or device PIN, and it only works on Foxhound, so it cannot be phished."
      />
      <div className="grid gap-3">
        <Button
          type="button"
          variant="primary"
          size="lg"
          pending={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            const res = await authClient.passkey.addPasskey();
            setBusy(false);
            if (res?.error) {
              setError("The passkey was not saved. Try again, or skip it for now.");
              return;
            }
            window.location.assign(next);
          }}
        >
          {busy ? "Waiting for your device..." : "Add a passkey"}
        </Button>
        {error ? <Alert tone="crit">{error}</Alert> : null}
      </div>
      <AuthFootnote>
        <AuthLink to={next}>Not now</AuthLink>
      </AuthFootnote>
    </AuthCard>
  );
}
