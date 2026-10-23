import { useEffect, useRef } from "react";
import { data, useNavigation, useSearchParams } from "react-router";
import { Alert, Banner } from "capsomer/react/banner";
import { Button } from "capsomer/react/button";
import { Pill } from "capsomer/react/status";
import "capsomer/banner.css";
import "capsomer/button.css";
import "capsomer/field.css";
import "capsomer/panel.css";
import "capsomer/status.css";

import { DemoGuardedForm } from "~/components/demo-guarded-form";
import { SettingsBackLink } from "~/components/settings-back-link";
import { getDb } from "~/db";
import { authContext, createInvite, hasOpenInviteForEmail, listMembers, removeMember, MEMBER_ROLE } from "~/lib/auth";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { RATE_LIMIT_INVITE } from "~/lib/constants";
import { isWithinRateLimit } from "~/lib/http/rate-limit";
import { isValidReplyToEmail } from "~/lib/settings/reply-to";
import { pendingState, shouldClearInvite, type TeamActionData } from "~/lib/settings/team-page";
import { sendTeamInviteEmail, teamInviteEmailNotice } from "~/lib/settings/team-invite-email.server";

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

  const form = await request.formData();
  // No `_action` is an invite, so a plain post keeps working.
  const intent = String(form.get("_action") ?? "invite") === "remove" ? "remove" : "invite";

  // Every result says which form it answers (`action`), and a remove result
  // names its row (`memberId`), so each form reads only its own result.
  if (intent === "remove") {
    const memberId = String(form.get("memberId") ?? "").trim() || null;
    const refuse = (error: string, status: number) =>
      data<TeamActionData>({ action: "remove", error, invited: null, inviteUrl: null, memberId }, { status });

    // The actor's role, checked on the server before anything else.
    if (membership.role !== MEMBER_ROLE.OWNER) {
      return refuse("Only the account owner can remove members.", 403);
    }
    if (!memberId) return refuse("Select a member to remove.", 400);
    // Scoped to the ACTIVE account inside removeMember, so a member id from
    // another account is refused exactly like one that does not exist.
    const result = await removeMember(db, membership.accountId, memberId);
    if (!result.ok) {
      return refuse(
        result.reason === "is_owner" ? "The account owner cannot be removed." : "That member is not on this account.",
        403,
      );
    }
    return data<TeamActionData>({ action: "remove", error: null, invited: null, inviteUrl: null, memberId });
  }

  const refuse = (error: string, status: number) =>
    data<TeamActionData>({ action: "invite", error, invited: null, inviteUrl: null, memberId: null }, { status });

  if (membership.role !== MEMBER_ROLE.OWNER) {
    return refuse("Only the account owner can invite teammates.", 403);
  }

  // E2: RECOVA'S REFUSALS, in Recova's order and before anything is written
  // (app/api/invite/route.ts, blob 960aefc6): the IP rate limit (429), a
  // malformed address (400), and a pending or active membership (409).
  //
  // The limit is 311's limiter, used unchanged, at Recova's RATE_LIMIT_SIGNUP
  // numbers on `invite:{ip}`, and fails open like every other caller (Recova's
  // limiter does too). It is spent on every invite attempt, as Recova's is.
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  if (!(await isWithinRateLimit(env, "invite", ip, RATE_LIMIT_INVITE.max, RATE_LIMIT_INVITE.windowMs))) {
    return refuse("Too many requests. Try again later.", 429);
  }
  const email = String(form.get("email") ?? "").trim();
  if (!email) return refuse("Enter an email address to invite.", 400);
  // One address: no whitespace or control characters (so no line break and no
  // second address after a space), no comma, semicolon or angle brackets, and
  // a dot in the domain. The address becomes the To of the invite email, so
  // the reply-to field's server check (J03) is the right one, reused as is.
  if (!isValidReplyToEmail(email)) return refuse("Invalid email address", 400);
  if (await hasOpenInviteForEmail(db, membership.accountId, email)) {
    return refuse("This email already has a pending or active membership", 409);
  }

  const { token, memberId } = await createInvite(db, membership.accountId, email);
  const url = new URL(request.url);
  const inviteUrl = `${url.origin}/invite/${token}`;
  // E2: Recova emails the invitee here, after the pending row is written
  // (app/api/invite/route.ts, blob 960aefc6). The link stays on the page as
  // well, and when the email did not go the page says so rather than
  // reporting success as Recova does (RULES.md 3.16).
  const sent = await sendTeamInviteEmail(env, {
    accountId: membership.accountId,
    to: email,
    accountName: membership.accountName,
    inviteUrl,
    memberId,
    token,
  });
  return data<TeamActionData>({
    action: "invite",
    error: null,
    invited: email,
    inviteUrl,
    memberId: null,
    emailStatus: sent.status,
    emailError: teamInviteEmailNotice(sent.status),
  });
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
// The heading is composed on the five sizes (Capsomer's page head computes
// 22px, off them). The row buttons are Capsomer's sm size (13px, text-label),
// because xs computes 12px, also off them; Capsomer's pills compute 12px with
// no size to choose, which is for Capsomer's per-site layer to map.
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
// Foxhound's share link beside the invite email (E2), and when the email did
// not go an alert says so, where Recova would still say "Invite sent to"
// (RULES.md 1.2).
export default function Team({ loaderData, actionData }: Route.ComponentProps) {
  const navigation = useNavigation();
  // Pending belongs to the form that was sent: a remove marks its row, an
  // invite the invite button.
  const pending = pendingState(navigation.state === "idle" ? undefined : navigation.formData);
  const confirmingId = useSearchParams()[0].get("confirm");

  // Results belong to the form they answer.
  const removeResult = actionData?.action === "remove" ? actionData : null;
  const inviteResult = actionData?.action === "invite" ? actionData : null;

  // Clear the field only after an invite that worked; a remove result or a
  // refused invite leaves a half-typed address alone.
  const inviteInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (shouldClearInvite(actionData) && inviteInput.current) inviteInput.current.value = "";
  }, [actionData]);

  return (
    <>
      <SettingsBackLink />
      {/* Recova's PageHeader: h1 text-title medium, the line in text-label.
          Composed on the five sizes, because Capsomer's page head computes
          22px at weight 800, off them (RULES.md 5.2). */}
      <div className="mb-8">
        <h1 className="mb-1 text-title font-medium text-text">Team</h1>
        <p className="text-label text-text-subtle">Members and pending invites for this account.</p>
      </div>

      <section className="cap-panel">
        <div className="cap-panel-body">
          {removeResult && !removeResult.error ? (
            <p role="status" className="sr-only">
              Member removed.
            </p>
          ) : null}
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
                          <Button type="submit" variant="danger" size="sm" pending={pending.removing === m.id}>
                            {pending.removing === m.id ? "Removing..." : "Yes, remove member"}
                          </Button>
                          <a href="?" className="cap-btn" data-variant="quiet" data-size="sm">
                            Cancel
                          </a>
                        </DemoGuardedForm>
                      ) : (
                        <a href={"?confirm=" + m.id} className="cap-btn" data-variant="quiet" data-size="sm">
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
              <DemoGuardedForm method="post" className="border-t border-border pt-5">
                <input type="hidden" name="_action" value="invite" />
                {/* Capsomer's field through its HTML contract, with the aria
                    wiring its React Field would add. The React Field takes one
                    control, so the button cannot share the input's row as
                    Recova has it, and its required prop prints a "Required"
                    marker Recova never had: a Capsomer gap. */}
                <div className="cap-field" data-invalid={inviteResult?.error ? "true" : undefined}>
                  <label className="cap-field-label" htmlFor="invite_email">
                    Invite a team member
                  </label>
                  <div className="flex gap-2">
                    <div className="min-w-0 flex-1">
                      <input
                        ref={inviteInput}
                        id="invite_email"
                        className="cap-input"
                        type="email"
                        name="email"
                        autoComplete="email"
                        placeholder="colleague@company.com"
                        required
                        aria-invalid={inviteResult?.error ? true : undefined}
                        aria-describedby={inviteResult?.error ? "invite_email-error" : undefined}
                      />
                    </div>
                    <Button type="submit" variant="primary" pending={pending.invite}>
                      {pending.invite ? "Sending\u2026" : "Send invite"}
                    </Button>
                  </div>
                  <p className="cap-field-error" id="invite_email-error" hidden={!inviteResult?.error}>
                    {inviteResult?.error ?? null}
                  </p>
                </div>
                {/* A refused remove, where Recova's TeamSection shows it: its
                    one error line under the invite row. An alert, and not
                    the field's error, since the address is not what was
                    wrong. Showing it at the row instead is a question for
                    Dustin (J31 notes). */}
                {removeResult?.error ? (
                  <div className="mt-2">
                    <Alert tone="crit">{removeResult.error}</Alert>
                  </div>
                ) : null}
                {inviteResult?.inviteUrl ? (
                  <div className="mt-2">
                    <Banner tone="ok">
                      Invited {inviteResult.invited}. Share this link: {inviteResult.inviteUrl}
                    </Banner>
                  </div>
                ) : null}
                {inviteResult && "emailError" in inviteResult && inviteResult.emailError ? (
                  <div className="mt-2">
                    <Alert tone="crit">{inviteResult.emailError}</Alert>
                  </div>
                ) : null}
              </DemoGuardedForm>
            ) : null}
        </div>
      </section>
    </>
  );
}
