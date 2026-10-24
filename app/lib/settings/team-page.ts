// /settings/team (S26, J31): the page's client-side decisions, kept pure so
// they can be tested without a browser. No server import: the route's client
// chunk loads this.

/** What the team action returns. `action` says which form it answers. */
export type TeamActionData =
  | { action: "invite"; error: string; invited: null; inviteUrl: null; memberId: null }
  | {
      action: "invite";
      error: null;
      invited: string;
      inviteUrl: string;
      memberId: null;
      /** How the invite email went (E2), and the line the page shows when it did not. */
      emailStatus: string;
      emailError: string | null;
    }
  | { action: "remove"; error: string; invited: null; inviteUrl: null; memberId: string | null }
  | { action: "remove"; error: null; invited: null; inviteUrl: null; memberId: string };

/** Which form, and which row, a pending submission belongs to. */
export interface TeamPending {
  invite: boolean;
  removing: string | null;
}

/**
 * Pending state per form, read from the submission in flight
 * (useNavigation().formData). A remove marks only its own row and an invite
 * only the invite button, so one form never shows the other's "Sending".
 * A post with no `_action` is an invite, as the action reads it.
 */
export function pendingState(formData: FormData | undefined): TeamPending {
  if (!formData) return { invite: false, removing: null };
  const intent = String(formData.get("_action") ?? "invite");
  if (intent === "remove") return { invite: false, removing: String(formData.get("memberId") ?? "") || null };
  return { invite: intent === "invite", removing: null };
}

/** Clear the invite field only after an invite that worked, as Recova does. A
 *  remove result, or a refused invite, leaves what was typed. */
export function shouldClearInvite(actionData: TeamActionData | undefined): boolean {
  return actionData?.action === "invite" && actionData.error === null;
}
