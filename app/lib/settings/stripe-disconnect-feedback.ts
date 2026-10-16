// What /settings/stripe says after a disconnect posts (J41, row S37).
//
// Recova's StripeSection (blob 4068961e) has two outcomes: on success it sends
// the browser to /settings, and on anything else it raises one browser alert,
// "Could not disconnect Stripe. Try again or contact support.", and resets the
// confirm. The success half is the action's redirect; this decides the rest.
//
// The warning is Foxhound's own and has no Recova twin: the disconnect stood
// but revoking the grant at Stripe did not, and saying nothing would leave the
// merchant believing Stripe access was revoked. So it stays on the page.

export const DISCONNECT_FAILED = "Could not disconnect Stripe. Try again or contact support.";

export interface DisconnectResult {
  action: string;
  ok: boolean;
  error?: string;
  warning?: string;
}

export type DisconnectFeedback = { kind: "alert"; message: string } | { kind: "warning"; message: string } | null;

export function disconnectFeedback(result: DisconnectResult | undefined): DisconnectFeedback {
  if (!result || result.action !== "disconnect-stripe") return null;
  if (!result.ok) return { kind: "alert", message: DISCONNECT_FAILED };
  if (result.warning) return { kind: "warning", message: result.warning };
  return null;
}
