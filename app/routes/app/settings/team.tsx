import { data, useNavigation, useSearchParams } from "react-router";

import { Alert, Field, Submit } from "~/components/auth-ui";
import { Badge } from "~/components/badge";
import { DemoGuardedForm } from "~/components/demo-guarded-form";
import { getDb } from "~/db";
import { authContext, createInvite, listMembers, removeMember, MEMBER_ROLE } from "~/lib/auth";
import { cloudflareContext } from "~/lib/cloudflare-context";

import type { Route } from "./+types/team";

export function meta() {
  return [{ title: "Team - Foxhound" }];
}

// This page is scoped to ONE account, the active one: invites add a member to
// the account the caller is currently looking at. That is unchanged by
// multi-account; what changed is that the caller can now switch which account
// that is (ruling 326 phases (a) to (e)). This comment previously cited
// `account_members_one_active_per_user_uq` and said "creating or switching
// accounts is not built", both true when written and both false now: 324 struck
// that index and phase (e) shipped the switcher.
//
// S26: MEMBER REMOVAL IS NOW BUILT, and the sentence that used to sit here
// saying it was not, "because account_members has no status beyond
// active/pending to represent it", reasoned from the wrong mechanism. Legacy
// does not represent removal as a status at all: `api/team/remove` (blob
// 3fd92550) DELETES the row. No schema decision was owed.
//
// Legacy's confirm is inline and two-step, the settings section's house pattern
// (S37, S33). The confirming id rides the URL rather than useState so the form
// post carries it, exactly as S37's disconnect does.
//
// ROLE CHANGE is still not built, and legacy has no role-change control either.
export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const { membership } = context.get(authContext);
  const auth = context.get(authContext);
  const members = await listMembers(getDb(env), membership.accountId);
  const isOwner = membership.role === MEMBER_ROLE.OWNER;
  return {
    accountName: membership.accountName,
    isOwner,
    // LEGACY'S THREE REFUSALS, RESOLVED HERE rather than in the render: owners
    // only, never yourself, never another owner. It is a plain boolean on
    // purpose. Deciding it in the component would mean importing MEMBER_ROLE,
    // and `~/lib/auth` is a server module: the build refuses it as
    // "Server-only module referenced by client", which is how this was caught.
    // The server enforces all three again inside removeMember; this only
    // decides what to draw.
    members: members.map((m) => ({
      ...m,
      removable: isOwner && m.userId !== auth.userId && m.role !== MEMBER_ROLE.OWNER,
    })),
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const { membership } = context.get(authContext);
  const db = getDb(env);

  if (membership.role !== MEMBER_ROLE.OWNER) {
    return data(
      { error: "Only the account owner can invite teammates.", invited: null, inviteUrl: null },
      { status: 403 },
    );
  }

  const form = await request.formData();
  const intent = String(form.get("_action") ?? "invite");

  if (intent === "remove") {
    const memberId = String(form.get("memberId") ?? "").trim();
    if (!memberId) {
      return data(
        { error: "Select a member to remove.", invited: null, inviteUrl: null },
        { status: 400 },
      );
    }
    // Scoped to the ACTIVE account inside removeMember, so a member id from
    // another account is refused exactly like one that does not exist.
    const result = await removeMember(db, membership.accountId, memberId);
    if (!result.ok) {
      return data(
        {
          error:
            result.reason === "is_owner"
              ? "The account owner cannot be removed."
              : "That member is not on this account.",
          invited: null,
          inviteUrl: null,
        },
        { status: 403 },
      );
    }
    return data({ error: null, invited: null, inviteUrl: null });
  }

  const email = String(form.get("email") ?? "").trim();
  if (!email) {
    return data(
      { error: "Enter an email address to invite.", invited: null, inviteUrl: null },
      { status: 400 },
    );
  }

  const { token } = await createInvite(db, membership.accountId, email);
  const url = new URL(request.url);
  const inviteUrl = `${url.origin}/invite/${token}`;
  return data({ error: null, invited: email, inviteUrl });
}

export default function Team({ loaderData, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  const confirmingId = useSearchParams()[0].get("confirm");

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-8">
      <h1 className="text-title font-medium text-text">
        Team {loaderData.accountName ? `- ${loaderData.accountName}` : ""}
      </h1>

      <section className="rounded-lg border border-border bg-surface p-5">
        <h2 className="text-label font-semibold text-text">Members</h2>
        <ul className="mt-4 flex flex-col gap-2">
          {loaderData.members.map((m) => (
            <li
              key={m.id}
              className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-label text-text-secondary"
            >
              <span className="min-w-0 truncate">{m.userId ? (m.userName ?? m.userEmail) : m.invitedEmail}</span>
              <span className="flex shrink-0 items-center gap-2">
                {/* `removable` is legacy's three refusals, resolved in the
                    loader. The server enforces them again. */}
                {m.removable ? (
                  confirmingId === m.id ? (
                    <DemoGuardedForm method="post" className="flex items-center gap-2">
                      <input type="hidden" name="_action" value="remove" />
                      <input type="hidden" name="memberId" value={m.id} />
                      <span className="text-micro text-text-subtle">
                        Remove {m.userName ?? m.userEmail ?? m.invitedEmail}?
                      </span>
                      <button
                        type="submit"
                        disabled={busy}
                        className="text-micro text-red transition-opacity duration-500 hover:opacity-80 disabled:opacity-60"
                      >
                        {busy ? "Removing..." : "Yes, remove member"}
                      </button>
                      <a
                        href="?"
                        className="text-micro text-text-subtle no-underline transition-opacity duration-500 hover:opacity-80"
                      >
                        Cancel
                      </a>
                    </DemoGuardedForm>
                  ) : (
                    <a
                      href={"?confirm=" + m.id}
                      className="text-micro text-text-subtle no-underline transition-opacity duration-500 hover:opacity-80"
                    >
                      Remove member
                    </a>
                  )
                ) : null}
                <Badge tone="neutral">{m.role}</Badge>
                {/* Legacy shows a status pill ONLY when pending, never an
                    "active" pill beside every member. */}
                {m.status === "active" ? null : <Badge tone="neutral">Pending</Badge>}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {loaderData.isOwner ? (
        <section className="rounded-lg border border-border bg-surface p-5">
          <h2 className="text-label font-semibold text-text">Invite a teammate</h2>
          <DemoGuardedForm method="post" className="mt-4 flex flex-col gap-3">
            {actionData?.error ? <Alert tone="error">{actionData.error}</Alert> : null}
            {actionData?.inviteUrl ? (
              <Alert tone="success">
                Invited {actionData.invited}. Share this link: {actionData.inviteUrl}
              </Alert>
            ) : null}
            <Field label="Invite email" name="email" type="email" />
            <div>
              <Submit disabled={busy}>{busy ? "Inviting..." : "Send invite"}</Submit>
            </div>
          </DemoGuardedForm>
        </section>
      ) : null}
    </div>
  );
}
