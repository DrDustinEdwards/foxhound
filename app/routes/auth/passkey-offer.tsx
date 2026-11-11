import { readForm } from "@dustinedwards/site-runtime/body";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import {
  dismissPasskeyOffer,
  sessionLookup,
  shouldOfferPasskey,
} from "@dustinedwards/site-runtime/sign-in";
import { PasskeyOffer } from "capsomer/react/sign-in-settings";
import { Form, redirect } from "react-router";

import { getAuth } from "~/lib/auth";
import { authClient } from "~/lib/auth/client";
import { nextPath, signedInLanding } from "~/lib/auth/landing.server";
import { BODY_MAX_BYTES } from "~/lib/http/body";
import { NOINDEX } from "~/lib/seo/meta";

import type { Route } from "./+types/passkey-offer";

// /passkey, where a sign-in by emailed link, typed code, Google or Apple lands
// (passkeyOfferURL): Capsomer's PasskeyOffer, so the next sign-in has no email
// to wait for, then on to `next` (A3). site-runtime's shouldOfferPasskey
// decides: someone with a passkey, or who said "Not now" in the last 30 days,
// goes straight on, and so does a browser with no platform authenticator
// (canOfferPasskey, in the part). "Not now" posts here and is kept for the
// person, not the browser (dismissPasskeyOffer).

export function meta() {
  return [{ title: "Create a passkey - Foxhound" }, NOINDEX];
}

/** The signed-in person and where they go on to; to /login when nobody is.
 *  `next` is settled here: an account not yet on Stripe goes on to /connect
 *  rather than an empty console. */
async function signedIn(request: Request, env: Env, raw: unknown) {
  const auth = await getAuth(env);
  const session = await auth.api.getSession(sessionLookup(request));
  if (!session) throw redirect("/login");
  const next = await signedInLanding(env, session, nextPath(raw));
  return { auth, session, next };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const raw = new URL(request.url).searchParams.get("next");
  const { auth, session, next } = await signedIn(request, env, raw);
  const passkeys = await auth.api.listPasskeys({ headers: request.headers });
  if (!(await shouldOfferPasskey(env.DB, session.user.id, passkeys))) throw redirect(next);
  return { next };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  // "Not now" carries `next` in its form; checked again here.
  const form = await readForm(request, BODY_MAX_BYTES);
  const { session, next } = await signedIn(request, env, form.get("next"));
  await dismissPasskeyOffer(env.DB, session.user.id, { request });
  throw redirect(next);
}

export default function PasskeyOfferPage({ loaderData }: Route.ComponentProps) {
  return (
    <PasskeyOffer
      layout="screen"
      client={authClient}
      next={loaderData.next}
      siteName="Foxhound"
      Form={Form}
    />
  );
}
