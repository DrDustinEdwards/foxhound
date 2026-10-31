import { confirmSignInLink, SIGN_IN_LINK_WORDS, signInLinkProblem } from "@dustinedwards/site-runtime/sign-in";
import { Alert } from "capsomer/react/banner";
import { Button } from "capsomer/react/button";
import { data } from "react-router";

import { AuthCard, AuthFootnote, AuthHeading, AuthLink } from "~/components/auth-card";
import { getAuth } from "~/lib/auth";
import { getSession } from "~/lib/auth/session";
import { DEFAULT_NEXT_PATH } from "~/lib/auth/next-path";
import { knownSignInError } from "~/lib/auth/sign-in-link.server";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { NOINDEX } from "~/lib/seo/meta";

import type { Route } from "./+types/sign-in-confirm";

// /sign-in/confirm, where the emailed sign-in link opens (site-runtime
// ./sign-in, CONFIRM_PATH). Its GET only shows this card, so a mail scanner
// that opens every link spends nothing; the button's POST signs in through
// confirmSignInLink, on to /passkey and `next`. A spent or expired link comes
// back here with ?error= and the time it was mailed, and site-runtime's
// signInLinkProblem tells used, expired, cut short and failed apart.

export function meta() {
  return [{ title: "Sign in - Foxhound" }, NOINDEX];
}

// The page's URL holds the token.
export const headers = () => ({ "Cache-Control": "no-store" });

export async function loader({ request, context }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const error = url.searchParams.get("error");
  // Only a failed link asks who is signed in: the button's GET reads nothing.
  const signedIn = error ? Boolean(await getSession(context.get(cloudflareContext).env, request)) : false;
  const problem = signInLinkProblem(url, { signedIn });
  if (!problem) return { problem: null };
  // A refusal that is not the link's own, such as a disposable address, keeps
  // Foxhound's words for it.
  const own = problem === "failed" ? knownSignInError(error) : null;
  return { problem, title: SIGN_IN_LINK_WORDS[problem].title, text: own ?? SIGN_IN_LINK_WORDS[problem].text };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const res = await confirmSignInLink(await getAuth(env), request);
  // Better Auth's redirect (signed in, or back here with ?error=), or its per-IP limit.
  if (res.status !== 429) return res;
  return data({ limited: true }, { status: 429 });
}

export default function SignInConfirm({ loaderData, actionData }: Route.ComponentProps) {
  if (loaderData.problem) {
    const signedIn = loaderData.problem === "signed-in";
    return (
      <AuthCard>
        <AuthHeading title={loaderData.title} />
        <Alert tone={signedIn ? "ok" : "crit"}>{loaderData.text}</Alert>
        <AuthFootnote>
          {signedIn ? <AuthLink to={DEFAULT_NEXT_PATH}>Go to Foxhound</AuthLink> : <AuthLink to="/login">Get a new link</AuthLink>}
        </AuthFootnote>
      </AuthCard>
    );
  }

  return (
    <AuthCard>
      <AuthHeading title="Sign in to Foxhound" />
      {/* A plain form: it posts to this URL, token and all, and the browser follows the redirect. */}
      <form method="post" className="grid gap-3">
        {actionData?.limited ? <Alert tone="crit">Too many attempts. Please try again in a minute.</Alert> : null}
        <Button type="submit" variant="primary" size="lg">
          Sign in
        </Button>
      </form>
    </AuthCard>
  );
}
