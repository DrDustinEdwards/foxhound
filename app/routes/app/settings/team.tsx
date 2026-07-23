import { data, useNavigation } from "react-router";

import { Alert, Field, Submit } from "~/components/auth-ui";
import { Badge } from "~/components/badge";
import { DemoGuardedForm } from "~/components/demo-guarded-form";
import { getDb } from "~/db";
import { authContext, createInvite, listMembers, MEMBER_ROLE } from "~/lib/auth";
import { cloudflareContext } from "~/lib/cloudflare-context";

import type { Route } from "./+types/team";

export function meta() {
  return [{ title: "Team - Foxhound" }];
}

// Single-account model (app/lib/auth/account.ts): invites add a member to this
// one account, they never create or switch accounts. There is no member
// removal or role change here because account_members has no status beyond
// active/pending to represent it (a schema decision, not built this slice).
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
  const url = new URL(request.url);
  const inviteUrl = `${url.origin}/invite/${token}`;
  return data({ error: null, invited: email, inviteUrl });
}

export default function Team({ loaderData, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";

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
                <Badge tone="neutral">{m.role}</Badge>
                <Badge tone={m.status === "active" ? "success" : "neutral"}>{m.status}</Badge>
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
