import { Button } from "capsomer/react/button";
import { data, Form, redirect, useNavigation } from "react-router";

import { AuthCard, AuthHeading } from "~/components/auth-card";
import { getDb } from "~/db";
import { acceptInvite, getInviteByToken, getSession, setSessionActiveAccount } from "~/lib/auth";
import type { Db } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";

import type { Route } from "./+types/invite";

// Row A7, /invite/:token (J28). Recova's app/invite/page.tsx (blob cd317a14),
// InviteClient.tsx (blob 0eb98af4) and app/api/invite/accept/route.ts (blob
// 13708537), read whole. The page is one 400px card, centered: "You've been
// invited", "Join <account> on Foxhound" and one "Accept invite" button, or,
// on any refusal, "Invite invalid" and the reason. The path is /invite/:token,
// not Recova's ?token= (APPROVED-DIFFERENCES, "Sign-in and invites").
//
// The button is offered whoever is looking, as Recova offers it:
// - signed in as the invited address: the invite is accepted and the session
//   moves to the account;
// - signed in as somebody else: refused with Recova's words;
// - signed out: the token goes into a short HttpOnly cookie and the visitor
//   goes to sign up with next= pointing back here. Recova's /auth/callback
//   read that cookie and accepted the invite; Foxhound's sign-in ends in
//   Better Auth, so the loader below does it instead when the visitor comes
//   back signed in carrying the cookie, and the invite is accepted without a
//   second click either way.

export function meta() {
  return [{ title: "Team invite - Foxhound" }];
}

/** Recova's cookie name and its one hour. Scoped to /invite, the only reader. */
const INVITE_COOKIE = "invite_token";
const INVITE_COOKIE_ATTRS = "Path=/invite; HttpOnly; Secure; SameSite=Lax";
const setInviteCookie = (token: string) =>
  `${INVITE_COOKIE}=${encodeURIComponent(token)}; ${INVITE_COOKIE_ATTRS}; Max-Age=3600`;
const clearInviteCookie = () => `${INVITE_COOKIE}=; ${INVITE_COOKIE_ATTRS}; Max-Age=0`;

function readInviteCookie(request: Request): string | null {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === INVITE_COOKIE) {
      try {
        return decodeURIComponent(rest.join("="));
      } catch {
        return null;
      }
    }
  }
  return null;
}

// A signed-in caller under another address gets this same sentence. Recova
// named the invited address there, which told anyone holding the link who it
// was for; that is a Recova bug not copied.
const INVALID = "This invite link is invalid or has expired.";

type Session = NonNullable<Awaited<ReturnType<typeof getSession>>>;

/** Accept for the signed-in caller and land them in the account, or say why not. */
async function accept(db: Db, token: string, session: Session, headers?: HeadersInit) {
  const result = await acceptInvite(db, token, session.user.id, session.user.email);
  if (result.ok) {
    // Point this session at the account they just joined, or at the one they
    // already held, so they land IN it. Recova answers redirect '/console' on
    // both paths (route.ts:55-57 and :70).
    await setSessionActiveAccount(db, session.session.id, result.accountId);
    return redirect("/console", { headers });
  }
  return result.reason === "email_mismatch"
    ? data({ accountName: null, error: INVALID }, { status: 403, headers })
    : data({ accountName: null, error: INVALID }, { status: 400, headers });
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const db = getDb(env);
  const [session, invite] = await Promise.all([getSession(env, request), getInviteByToken(db, params.token)]);
  const carried = readInviteCookie(request) === params.token;

  if (!invite) {
    return data(
      { accountName: null, error: INVALID },
      carried ? { headers: { "Set-Cookie": clearInviteCookie() } } : undefined,
    );
  }
  // Back from sign-up or sign-in after a signed-out "Accept invite".
  if (session && carried) {
    return accept(db, params.token, session, { "Set-Cookie": clearInviteCookie() });
  }
  return data({ accountName: invite.accountName, error: null as string | null });
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const db = getDb(env);
  const [session, invite] = await Promise.all([getSession(env, request), getInviteByToken(db, params.token)]);
  if (!invite) return data({ accountName: null, error: INVALID }, { status: 404 });

  if (!session) {
    const next = `/invite/${params.token}`;
    return redirect(`/signup?next=${encodeURIComponent(next)}`, {
      headers: { "Set-Cookie": setInviteCookie(params.token) },
    });
  }
  return accept(db, params.token, session);
}

export default function Invite({ loaderData, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  const error = actionData?.error ?? loaderData.error;

  return (
    <AuthCard>
      <div className="text-center">
        {error ? (
          <div role="alert">
            <h1 className="mb-2 text-subsection font-semibold text-text">Invite invalid</h1>
            <p className="text-copy text-text-subtle">{error}</p>
          </div>
        ) : (
          <>
            <AuthHeading
              title="You've been invited"
              subtitle={
                <>
                  Join <strong className="text-text">{loaderData.accountName ?? "a team"}</strong> on Foxhound
                </>
              }
            />
            {/* Recova's button: full width, text-sm, py-3. */}
            <Form method="post" className="grid [&_.cap-btn]:[--cap-btn-fs:var(--text-copy)] [&_.cap-btn]:[--cap-btn-h:2.75rem]">
              <Button type="submit" variant="primary" size="lg" pending={busy}>
                {busy ? "Accepting…" : "Accept invite"}
              </Button>
            </Form>
          </>
        )}
      </div>
    </AuthCard>
  );
}
