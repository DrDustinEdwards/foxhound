import { confirmEmailLink, emailLinkResult, type EmailLinkProblem } from "@dustinedwards/site-runtime/sign-in";
import { signalCurrentUserDetails } from "@dustinedwards/site-runtime/sign-in-client";
import { Alert } from "capsomer/react/banner";
import { Button } from "capsomer/react/button";
import { useEffect } from "react";
import { data } from "react-router";

import { AuthCard, AuthFootnote, AuthHeading, AuthLink } from "~/components/auth-card";
import { getAuth } from "~/lib/auth";
import { EMAIL_CHANGE_EXPIRES_IN_WORDS } from "~/lib/auth/send-auth-email";
import { getSession } from "~/lib/auth/session";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { NOINDEX } from "~/lib/seo/meta";

import type { Route } from "./+types/email-confirm";

// /email/confirm (site-runtime's EMAIL_CONFIRM_PATH), where both email-change
// links open (send-auth-email.ts mails emailConfirmURL). Its GET only shows the
// button, so a mail scanner that opens every link confirms nothing; the
// button's POST is site-runtime's confirmEmailLink, which runs Better Auth's
// verify-email with the token and comes back here with done= (the current
// address approved, so the new one is mailed; or the change made) or error=,
// which emailLinkResult reads.

export function meta() {
  return [{ title: "Confirm your email change - Foxhound" }, NOINDEX];
}

// The page's URL holds the token.
export const headers = () => ({ "Cache-Control": "no-store" });

export async function loader({ request, context }: Route.LoaderArgs) {
  const result = emailLinkResult(request.url);
  if (result.done !== "changed") return { ...result, newEmail: null };
  // The change is made and this browser signed in to it: the new address, for
  // the passkey providers (the Signal API, below).
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

/** What each outcome says. */
const DONE = {
  approved: {
    title: "Change approved",
    text: "We sent a link to the new address. Open it to finish the change. Until then you sign in with your current address.",
  },
  changed: { title: "Your email address is changed", text: "Your other devices were signed out." },
  verified: { title: "Email address confirmed", text: "There is nothing more to do." },
} as const;

const PROBLEM: Record<EmailLinkProblem, { title: string; text: string }> = {
  expired: {
    title: "This link has expired",
    text: `An email-change link works for ${EMAIL_CHANGE_EXPIRES_IN_WORDS}. Start the change again from your account settings.`,
  },
  done: { title: "This change is already made", text: "There is nothing more to do." },
  "other-account": {
    title: "You are signed in to another account",
    text: "Sign out of Foxhound in this browser, or open the link in another one, then open it again.",
  },
  invalid: {
    title: "This link no longer works",
    text: "It was used already, or a newer link took its place. Open the newest email-change link we sent, or start the change again.",
  },
  missing: {
    title: "This link is not complete",
    text: "It may have been cut short when it was copied. Open it straight from the email.",
  },
  failed: {
    title: "That did not finish",
    text: "Something went wrong on our side. Open the link again, or start the change again from your account settings.",
  },
};

export default function EmailConfirm({ loaderData, actionData }: Route.ComponentProps) {
  const { done, problem, newEmail } = loaderData;

  // The passkey providers show the new address on this account's passkeys.
  useEffect(() => {
    if (newEmail) void signalCurrentUserDetails({ name: newEmail });
  }, [newEmail]);

  if (done || problem) {
    const said = done ? DONE[done] : PROBLEM[problem as EmailLinkProblem];
    const text = done === "changed" && newEmail ? `You now sign in to Foxhound with ${newEmail}. ${said.text}` : said.text;
    return (
      <AuthCard>
        <AuthHeading title={said.title} />
        <Alert tone={done || problem === "done" ? "ok" : "crit"}>{text}</Alert>
        <AuthFootnote>
          <AuthLink to="/settings/account">Account settings</AuthLink>
        </AuthFootnote>
      </AuthCard>
    );
  }

  return (
    <AuthCard>
      <AuthHeading
        title="Confirm your email change"
        subtitle="Nothing changes until you press the button. Once both addresses confirm, your Foxhound sign-in moves to the new one."
      />
      {/* A plain form: it posts to this URL, token and all, and the browser follows the redirect. */}
      <form method="post" className="grid gap-3">
        {actionData?.limited ? <Alert tone="crit">Too many attempts. Please try again in a minute.</Alert> : null}
        <Button type="submit" variant="primary" size="lg">
          Confirm
        </Button>
      </form>
    </AuthCard>
  );
}
