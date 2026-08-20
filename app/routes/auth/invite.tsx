import { data, Form, redirect, useNavigation } from "react-router";

import { AuthShell, Submit, Alert, AuthLink } from "~/components/auth-ui";
import { getDb } from "~/db";
import { acceptInvite, getInviteByToken, getSession, setSessionActiveAccount } from "~/lib/auth";
import { cloudflareContext } from "~/lib/cloudflare-context";

import type { Route } from "./+types/invite";

export function meta() {
  return [{ title: "Team invite - Foxhound" }];
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const db = getDb(env);
  const [session, invite] = await Promise.all([
    getSession(env, request),
    getInviteByToken(db, params.token),
  ]);
  return {
    invite: invite
      ? { accountName: invite.accountName, invitedEmail: invite.invitedEmail }
      : null,
    userEmail: session?.user.email ?? null,
  };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const session = await getSession(env, request);
  if (!session) throw redirect("/login");

  const db = getDb(env);
  const result = await acceptInvite(
    db,
    params.token,
    session.user.id,
    session.user.email,
  );

  if (result.ok) {
    // Point this session at the account they just joined, or at the one they
    // already held, so they land IN it rather than in whichever account happens
    // to resolve first. Legacy's accept route does the same thing with its
    // cookie for the create path and answers `redirect: '/console'` for the
    // already-a-member path (route.ts:55-57, blob `13708537`); both land the
    // user on the invited account, which is the behaviour being ported.
    //
    // `alreadyMember` is true when nothing was written. The marker still moves,
    // because following an invite link to an account you already hold is a clear
    // statement of which account you want to be looking at.
    await setSessionActiveAccount(db, session.session.id, result.accountId);
    return redirect("/dashboard");
  }

  // `already_member` is gone as a rejection (ruling 327): holding the invited
  // account is now success, and holding a DIFFERENT account was never legacy's
  // business to refuse.
  const message =
    result.reason === "email_mismatch"
      ? "This invite is for a different email address."
      : "This invite is invalid or has expired.";
  return data({ error: message }, { status: 400 });
}

export default function Invite({ loaderData, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  const { invite, userEmail } = loaderData;

  if (!invite) {
    return (
      <AuthShell title="Invite not found" footer={<AuthLink to="/login">Sign in</AuthLink>}>
        <Alert tone="error">This invite is invalid or has expired.</Alert>
      </AuthShell>
    );
  }

  const subtitle = `You have been invited to join ${invite.accountName ?? "a Foxhound account"}.`;

  // Not signed in: prompt to authenticate with the invited address first.
  if (!userEmail) {
    return (
      <AuthShell
        title="Accept your invite"
        subtitle={subtitle}
        footer={
          <>
            <AuthLink to="/signup">Create an account</AuthLink> or{" "}
            <AuthLink to="/login">sign in</AuthLink> as {invite.invitedEmail} to
            accept.
          </>
        }
      >
        <Alert tone="success">Invited as {invite.invitedEmail}.</Alert>
      </AuthShell>
    );
  }

  // Signed in as the wrong identity.
  if (
    invite.invitedEmail &&
    userEmail.trim().toLowerCase() !== invite.invitedEmail.trim().toLowerCase()
  ) {
    return (
      <AuthShell
        title="Wrong account"
        subtitle={subtitle}
        footer={
          <Form method="post" action="/logout">
            <button type="submit" className="text-amber hover:underline">
              Sign out
            </button>
          </Form>
        }
      >
        <Alert tone="error">
          This invite is for {invite.invitedEmail}, but you are signed in as{" "}
          {userEmail}.
        </Alert>
      </AuthShell>
    );
  }

  // Signed in as the invited user: accept.
  return (
    <AuthShell title="Accept your invite" subtitle={subtitle}>
      <Form method="post" className="flex flex-col gap-4">
        {actionData?.error ? <Alert tone="error">{actionData.error}</Alert> : null}
        <Submit disabled={busy}>{busy ? "Joining..." : "Accept invite"}</Submit>
      </Form>
    </AuthShell>
  );
}
