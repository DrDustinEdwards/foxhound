// What /settings/stripe says after a disconnect posts. Try again or contact support.", and resets
// the confirm. So it stays on the page.

const DISCONNECT_FAILED = "Could not disconnect Stripe. Try again or contact support.";

export interface DisconnectResult {
  action: string;
  ok: boolean;
  error?: string;
  warning?: string;
}

export type DisconnectFeedback =
  | { kind: "alert"; message: string }
  | { kind: "warning"; message: string }
  | null;

export function disconnectFeedback(result: DisconnectResult | undefined): DisconnectFeedback {
  if (!result || result.action !== "disconnect-stripe") return null;
  if (!result.ok) return { kind: "alert", message: DISCONNECT_FAILED };
  if (result.warning) return { kind: "warning", message: result.warning };
  return null;
}
