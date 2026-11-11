import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import { confirmEmailLink, emailLinkResult } from "@dustinedwards/site-runtime/sign-in";
import { EmailConfirm } from "capsomer/react/sign-in";
import { data } from "react-router";

import { getAuth } from "~/lib/auth";
import { getSession } from "~/lib/auth/session";
import { NOINDEX } from "~/lib/seo/meta";

import type { Route } from "./+types/email-confirm";

// /email/confirm (site-runtime's EMAIL_CONFIRM_PATH), where both email-change
// links open (accountOptions mails emailConfirmURL), drawn by Capsomer's
// EmailConfirm. Its GET only shows the button, so a mail scanner that opens
// every link confirms nothing; the button's POST is site-runtime's
// confirmEmailLink, which runs Better Auth's verify-email with the token and
// comes back here with done= (the current address approved, so the new one is
// mailed; or the change made) or error=, which emailLinkResult reads.

export function meta() {
  return [{ title: "Confirm your email change - Foxhound" }, NOINDEX];
}

// The page's URL holds the token.
export const headers = () => ({ "Cache-Control": "no-store" });

export async function loader({ request, context }: Route.LoaderArgs) {
  const result = emailLinkResult(request.url);
  if (result.done !== "changed") return { ...result, newEmail: null };
  // The change is made and this browser signed in to it: the new address, for
  // the page, and EmailConfirm tells the passkey providers (the Signal API).
  const session = await getSession(context.get(cloudflareContext).env, request);
  return { ...result, newEmail: session?.user.email ?? null };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const res = await confirmEmailLink(await getAuth(env), request);
  // Better Auth's redirect back here, or its per-IP limit.
  if (res.status !== 429) return res;
  return data({ limited: true }, { status: 429 });
}

export default function EmailConfirmPage({ loaderData, actionData }: Route.ComponentProps) {
  const { done, problem, newEmail } = loaderData;

  return (
    <EmailConfirm
      layout="screen"
      siteName="Foxhound"
      settings="My account"
      settingsPath="/settings/account"
      done={done ?? null}
      problem={problem ?? null}
      email={newEmail}
      limited={actionData?.limited}
    />
  );
}
