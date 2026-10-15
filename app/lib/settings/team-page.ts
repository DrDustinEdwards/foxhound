// /settings/team (S26, J31): the page's client-side decisions, kept pure so
// they can be tested without a browser. No server import: the route's client
// chunk loads this.

/** What the team action returns. `action` says which form it answers. */
export type TeamActionData =
  | { action: "invite"; error: string; invited: null; inviteUrl: null; memberId: null }
  | { action: "invite"; error: null; invited: string; inviteUrl: string; memberId: null }
  | { action: "remove"; error: string; invited: null; inviteUrl: null; memberId: string | null }
  | { action: "remove"; error: null; invited: null; inviteUrl: null; memberId: string };

/** Which form, and which row, a pending submission belongs to. */
export interface TeamPending {
  invite: boolean;
  removing: string | null;
}

// STUB, J31 review: carries the page's behaviour before the fix (one busy
// flag for both forms) so the tests fail on their assertions.
export function pendingState(formData: FormData | undefined): TeamPending {
  return { invite: formData != null, removing: null };
}

// STUB, J31 review: the field used to reset on any change of the invite link,
// a remove result included.
export function shouldClearInvite(actionData: TeamActionData | undefined): boolean {
  return actionData != null;
}
