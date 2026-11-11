import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import { confirmSignInLink, signInLinkProblem } from "@dustinedwards/site-runtime/sign-in";
import { DISPOSABLE_EMAIL } from "@dustinedwards/site-runtime/sign-in-form";
import { SignInConfirm } from "capsomer/react/sign-in";
import { data, redirect } from "react-router";

import { getAuth } from "~/lib/auth";
import { getSession } from "~/lib/auth/session";
import { DEFAULT_NEXT_PATH } from "~/lib/auth/sign-in-paths";
import { NOINDEX } from "~/lib/seo/meta";

import type { Route } from "./+types/sign-in-confirm";

// /sign-in/confirm, where the emailed sign-in link opens (site-runtime
// ./sign-in, CONFIRM_PATH), drawn by Capsomer's SignInConfirm. Its GET only
// shows the button, so a mail scanner that opens every link spends nothing;
// the button's POST signs in through confirmSignInLink, on to /passkey and
// `next`. A spent or expired link comes back here with ?error= and the time it
// was mailed, and site-runtime's signInLinkProblem tells used, expired, cut
// short and failed apart.

export function meta() {
  return [{ title: "Sign in - Foxhound" }, NOINDEX];
}

// The page's URL holds the token.
export const headers = () => ({ "Cache-Control": "no-store" });

export async function loader({ request, context }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const error = url.searchParams.get("error");
  // A new account refused for its disposable address is not the link's
  // problem: /login says so in the network's words (signInErrorWords).
  if (error === DISPOSABLE_EMAIL) throw redirect(`/login?error=${DISPOSABLE_EMAIL}`);
  // Only a failed link asks who is signed in: the button's GET reads nothing.
  const signedIn = error
    ? Boolean(await getSession(context.get(cloudflareContext).env, request))
    : false;
  return { problem: signInLinkProblem(url, { signedIn }) };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const res = await confirmSignInLink(await getAuth(env), request);
  // Better Auth's redirect (signed in, or back here with ?error=), or its per-IP limit.
  if (res.status !== 429) return res;
  return data({ limited: true }, { status: 429 });
}

export default function SignInConfirmPage({ loaderData, actionData }: Route.ComponentProps) {
  return (
    <SignInConfirm
      layout="screen"
      siteName="Foxhound"
      problem={loaderData.problem}
      limited={actionData?.limited}
      signInPath="/login"
      continuePath={DEFAULT_NEXT_PATH}
    />
  );
}
