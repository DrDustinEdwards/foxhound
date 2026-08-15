// The queued email job: everything the consumer needs to render + send one
// message and log it. Produced by the recovery/win-back engine (Phase 4b/4e),
// consumed by the queue handler. Kept transport-agnostic; only send.ts touches
// the binding.
export interface EmailJob {
  accountId: string | null;
  /** Links the send to its recovery step (one of recovery/winBack set, or neither for merchant notices). */
  recoveryStepId?: string | null;
  winBackStepId?: string | null;
  /** Recipient address (never persisted raw; email_sends stores a hash). */
  to: string;
  /** Display name for the From header (merchant sender name), optional. */
  fromName?: string | null;
  subject: string;
  bodyHtml: string;
  /** email_sends.template label (e.g. recovery_dunning, winback, merchant_notify). */
  template: string;
  /** CAN-SPAM one-click unsubscribe token (required for merchant-customer sends). */
  unsubscribeToken: string;
  /** CAN-SPAM sender postal address (required for merchant-customer sends). */
  physicalAddress: string;
  /** Stable per logical send so a re-delivery is recognizable by the caller. */
  idempotencyKey: string;
  /** The cron run that produced this send (313). Null for request-thread sends. */
  cronRunId?: string | null;
}
