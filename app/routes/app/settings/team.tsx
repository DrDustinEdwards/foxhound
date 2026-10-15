import { data, useNavigation, useSearchParams } from "react-router";
import { Alert } from "capsomer/react/banner";
import { Button } from "capsomer/react/button";
import { PageHead } from "capsomer/react/page-head";
import { Pill } from "capsomer/react/status";
import "capsomer/banner.css";
import "capsomer/button.css";
import "capsomer/field.css";
import "capsomer/page-head.css";
import "capsomer/panel.css";
import "capsomer/status.css";

import { DemoGuardedForm } from "~/components/demo-guarded-form";
import { SettingsBackLink } from "~/components/settings-back-link";
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
  // No account name: Recova's heading is "Team" alone (J31), and the header's
  // business tile already names the account this page is scoped to.
  return {
    isOwner,
    // LEGACY'S THREE REFUSALS, RESOLVED HERE rather than in the render: owners
    // only, never yourself, never another owner. It is a plain boolean on
    // purpose. Deciding it in the component would mean importing MEMBER_ROLE,
    // and `~/lib/auth` is a server module: the build refuses it as
    // "Server-only module referenced by client", which is how this was caught.
    // The server enforces all three again inside removeMember; this only
    // decides what to draw.
    //
    // OWNER FIRST, as Recova's TeamSection sorts its list; everyone else keeps
    // the order they were added (listMembers' order). Array sort is stable.
    members: members
      .map((m) => ({
        ...m,
        isOwnerRole: m.role === MEMBER_ROLE.OWNER,
        removable: isOwner && m.userId !== auth.userId && m.role !== MEMBER_ROLE.OWNER,
      }))
      .sort((a, b) => Number(b.isOwnerRole) - Number(a.isOwnerRole)),
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

/** The row's name, Recova's order: full name, else email, else the invited
 *  address. `||` as Recova has it, so an empty name falls through. */
function displayName(m: { userId: string | null; userName: string | null; userEmail: string | null; invitedEmail: string | null }): string {
  return (m.userId ? m.userName || m.userEmail : null) || m.invitedEmail || "";
}

// J31 (job_8d030f93c15f), row S26: Recova's page (app/(app)/settings/team/page.tsx,
// blob 09983bed; TeamSection.tsx, blob ab19f9de) on Capsomer's parts, teal.
//
// Recova, top to bottom: the phone-only Settings link, the page head "Team"
// with its line, then ONE card: the member rows, owner first, a rule between
// them, and for an owner the invite form under a rule, its input and button on
// one row and the result line under them. No column of its own: the settings
// layout gives Recova's 800px column and padding (app/layouts/settings.tsx).
//
// The card is Capsomer's panel through its HTML contract, body only, because
// the React Panel always draws a header band and Recova's card has none (the
// gap J53 and J62 named). The member list is composed inside it: Capsomer's
// row list is for rows that open a detail, and these open nothing. Pills,
// buttons, the field and the notices are Capsomer's; the teal comes from the
// app shell's family wrapper (app/layouts/app-shell.tsx).
//
// Two words differ from Recova on purpose. The role pill says "Owner" or
// "Member", never the raw database value (RULES.md 1.5). The success line keeps
// Foxhound's share link, because Foxhound sends no invite email yet (J83, E2),
// so Recova's "Invite sent to" would be untrue (RULES.md 1.2).
export default function Team({ loaderData, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  const confirmingId = useSearchParams()[0].get("confirm");

  return (
    <>
      <SettingsBackLink />
      <div className="mb-8">
        <PageHead title="Team" lead="Members and pending invites for this account." />
      </div>

      <section className="cap-panel">
        <div className="cap-panel-body">
          <div>
            <ul className="flex flex-col" aria-label="Members">
              {loaderData.members.map((m) => {
                const name = displayName(m);
                return (
                  <li
                    key={m.id}
                    className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-border py-3 last:border-b-0"
                  >
                    <span className="min-w-0 break-words text-label text-text">{name}</span>
                    <span className="flex flex-wrap items-center justify-end gap-2">
                      {/* `removable` is legacy's three refusals, resolved in the
                          loader. The server enforces them again. */}
                      {m.removable ? (
                        confirmingId === m.id ? (
                          <DemoGuardedForm method="post" className="flex flex-wrap items-center gap-1.5">
                            <input type="hidden" name="_action" value="remove" />
                            <input type="hidden" name="memberId" value={m.id} />
                            <span className="text-micro text-text-subtle">Remove {name}?</span>
                            <Button type="submit" variant="danger" size="xs" pending={busy}>
                              {busy ? "Removing..." : "Yes, remove member"}
                            </Button>
                            <a href="?" className="cap-btn" data-variant="quiet" data-size="xs">
                              Cancel
                            </a>
                          </DemoGuardedForm>
                        ) : (
                          <a href={"?confirm=" + m.id} className="cap-btn" data-variant="quiet" data-size="xs">
                            Remove member
                            <span className="sr-only">{" " + name}</span>
                          </a>
                        )
                      ) : null}
                      <Pill variant={m.isOwnerRole ? "default" : "secondary"}>
                        {m.isOwnerRole ? "Owner" : "Member"}
                      </Pill>
                      {/* Legacy shows a status pill ONLY when pending, never an
                          "active" pill beside every member. */}
                      {m.status === "active" ? null : <Pill variant="secondary">Pending</Pill>}
                    </span>
                  </li>
                );
              })}
            </ul>

            {loaderData.isOwner ? (
              <DemoGuardedForm method="post" className="mt-5 border-t border-border pt-5">
                <div className="cap-field">
                  <label className="cap-field-label" htmlFor="invite_email">
                    Invite a team member
                  </label>
                  <div className="flex gap-2">
                    <div className="min-w-0 flex-1">
                      {/* Keyed on the last invite link, so a sent invite clears
                          the field as Recova's does. */}
                      <input
                        key={actionData?.inviteUrl ?? "invite"}
                        id="invite_email"
                        className="cap-input"
                        type="email"
                        name="email"
                        autoComplete="email"
                        placeholder="colleague@company.com"
                        required
                      />
                    </div>
                    <Button type="submit" variant="primary" pending={busy}>
                      {busy ? "Sending\u2026" : "Send invite"}
                    </Button>
                  </div>
                </div>
                {actionData?.inviteUrl ? (
                  <div className="mt-2">
                    <Alert tone="ok">
                      Invited {actionData.invited}. Share this link: {actionData.inviteUrl}
                    </Alert>
                  </div>
                ) : null}
                {actionData?.error ? (
                  <div className="mt-2">
                    <Alert tone="crit">{actionData.error}</Alert>
                  </div>
                ) : null}
              </DemoGuardedForm>
            ) : null}
          </div>
        </div>
      </section>
    </>
  );
}
