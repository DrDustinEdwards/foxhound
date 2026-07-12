import { data, Form, useNavigation } from "react-router";

import { Field, Submit, Alert } from "~/components/auth-ui";
import { getDb } from "~/db";
import { authContext, createInvite, listMembers, MEMBER_ROLE } from "~/lib/auth";
import { cloudflareContext } from "~/lib/cloudflare-context";

import type { Route } from "./+types/team";

export function meta() {
  return [{ title: "Team - Foxhound" }];
}

// Minimal team surface: list members and create invites. Phase 5 owns the full
// settings UI; Phase 3 seeds the invite-creation path so the invite flow is
// exercisable end to end. Session + account are guaranteed by the app-shell
// middleware; read them from authContext.
export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const { membership } = context.get(authContext);
  const members = await listMembers(getDb(env), membership.accountId);
  return {
    accountName: membership.accountName,
    isOwner: membership.role === MEMBER_ROLE.OWNER,
    members,
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const { membership } = context.get(authContext);
  const db = getDb(env);

  // Only owners invite teammates.
  if (membership.role !== MEMBER_ROLE.OWNER) {
    return data(
      { error: "Only the account owner can invite teammates.", invited: null, inviteUrl: null },
      { status: 403 },
    );
  }

  const form = await request.formData();
  const email = String(form.get("email") ?? "").trim();
  if (!email) {
    return data(
      { error: "Enter an email address to invite.", invited: null, inviteUrl: null },
      { status: 400 },
    );
  }

  const { token } = await createInvite(db, membership.accountId, email);
  // The invite link the owner shares. Phase 4 will also email it via the send
  // module; for now it is returned to the UI.
  const url = new URL(request.url);
  const inviteUrl = `${url.origin}/invite/${token}`;
  return data({ error: null, invited: email, inviteUrl });
}

export default function Team({ loaderData, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-10">
      <h1 className="text-title font-medium text-text">
        Team {loaderData.accountName ? `- ${loaderData.accountName}` : ""}
      </h1>

      {loaderData.isOwner ? (
        <Form method="post" className="flex flex-col gap-3">
          {actionData?.error ? <Alert tone="error">{actionData.error}</Alert> : null}
          {actionData?.inviteUrl ? (
            <Alert tone="success">
              Invited {actionData.invited}. Share this link: {actionData.inviteUrl}
            </Alert>
          ) : null}
          <Field label="Invite email" name="email" type="email" />
          <Submit disabled={busy}>{busy ? "Inviting..." : "Send invite"}</Submit>
        </Form>
      ) : null}

      <ul className="flex flex-col gap-2">
        {loaderData.members.map((m) => (
          <li
            key={m.id}
            className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-label text-text-secondary"
          >
            <span>{m.userId ? m.userId : m.invitedEmail}</span>
            <span className="font-mono text-micro uppercase text-text-tertiary">
              {m.role} / {m.status}
            </span>
          </li>
        ))}
      </ul>
    </main>
  );
}
