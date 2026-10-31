import { dismissPasskeyOffer, shouldOfferPasskey } from "@dustinedwards/site-runtime/sign-in";
import { canOfferPasskey } from "@dustinedwards/site-runtime/sign-in-client";
import { Alert } from "capsomer/react/banner";
import { Button } from "capsomer/react/button";
import { useEffect, useState } from "react";
import { Form, redirect, useNavigation } from "react-router";

import { AuthCard, AuthFootnote, AuthHeading } from "~/components/auth-card";
import { getAuth } from "~/lib/auth";
import { authClient, signInAgainIfStale } from "~/lib/auth/client";
import { signedInLanding } from "~/lib/auth/landing.server";
import { safeNextPath } from "~/lib/auth/next-path";
import { cloudflareContext } from "~/lib/cloudflare-context";

import type { Route } from "./+types/passkey-offer";
import { NOINDEX } from "~/lib/seo/meta";

// /passkey, where a sign-in by emailed link, typed code, Google or Apple lands
// (passkeyOfferURL, app/lib/auth/sign-in-link.server.ts): it offers a passkey,
// so the next sign-in has no email to wait for, and goes on to `next` (A3).
// site-runtime's shouldOfferPasskey decides: someone with a passkey, or who
// said "Not now" in the last 30 days, goes straight on, and so does a browser
// with no platform authenticator (canOfferPasskey). "Not now" posts here and
// is kept for the person, not the browser (dismissPasskeyOffer). Foxhound's
// own page, in the sign-in card.

export function meta() {
  return [{ title: "Create a passkey - Foxhound" }, NOINDEX];
}

/** The signed-in person and where they go on to; to /login when nobody is.
 *  `next` is settled here: an account not yet on Stripe goes on to /connect
 *  rather than an empty console. */
async function signedIn(request: Request, env: Env) {
  const auth = await getAuth(env);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) throw redirect("/login");
  const next = await signedInLanding(env, session, safeNextPath(new URL(request.url).searchParams.get("next")));
  return { auth, session, next };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const { auth, session, next } = await signedIn(request, env);
  const passkeys = await auth.api.listPasskeys({ headers: request.headers });
  if (!(await shouldOfferPasskey(env.DB, session.user.id, passkeys))) throw redirect(next);
  return { next };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const { session, next } = await signedIn(request, env);
  await dismissPasskeyOffer(env.DB, session.user.id, { request });
  throw redirect(next);
}

export default function PasskeyOffer({ loaderData }: Route.ComponentProps) {
  const { next } = loaderData;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigation = useNavigation();

  // A device that cannot make a passkey here is not asked.
  useEffect(() => {
    void canOfferPasskey().then((can) => {
      if (!can) window.location.replace(next);
    });
  }, [next]);

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
            if (signInAgainIfStale(res?.error)) return;
            setBusy(false);
            if (res?.error) {
              setError("The passkey was not saved. Try again, or skip it for now.");
              return;
            }
            window.location.assign(next);
          }}
        >
          {busy ? "Waiting for your device..." : "Create a passkey"}
        </Button>
        {error ? <Alert tone="crit">{error}</Alert> : null}
      </div>
      <AuthFootnote>
        {/* Kept for 30 days for this person, on every device. */}
        <Form method="post">
          <Button type="submit" variant="link" pending={navigation.state !== "idle"}>
            Not now
          </Button>
        </Form>
      </AuthFootnote>
    </AuthCard>
  );
}
