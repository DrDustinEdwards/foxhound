import type { BulkActionIntent, BulkFailureReason } from "~/lib/recovery/bulk-results";
import { isBulkActionIntent } from "~/lib/recovery/bulk-results";

/** Why one payment did not take the action, in the merchant's words. */
export const BULK_REASON_LABELS: Record<BulkFailureReason, string> = {
  not_found: "No longer on this account",
  not_active: "No longer active",
  already_resolved: "Already resolved",
  write_failed: "The change did not save",
  no_pending_step: "No step left to run",
  unknown_step_type: "This step has no action",
  processing_paused: "Processing is paused for this account",
  customer_unsubscribed: "The customer is unsubscribed, so nothing was sent",
  send_retrying: "The send did not go through, and will be retried",
  step_failed: "The step ran and did not complete",
  unexpected: "Unexpected response, nothing changed",
};

export const BULK_INTENTS = {
  trigger: {
    label: "Trigger next step",
    didLabel: "Ran",
    didNotLabel: "Did not run",
    question: "Run the next step now for",
    consequence:
      "Each payment's next scheduled step runs immediately, and a step that sends email will send it.",
  },
  mark_recovered: {
    label: "Mark recovered",
    didLabel: "Recorded",
    didNotLabel: "Not recorded",
    question: "Mark as recovered",
    consequence:
      "This records a recovery you have confirmed elsewhere. It does not charge anyone and it does not contact the customer.",
  },
  cancel: {
    label: "Stop recovery",
    didLabel: "Stopped",
    didNotLabel: "Not stopped",
    question: "Stop recovery for",
    consequence:
      "Their remaining steps will not send. This does not refund anything and it does not contact the customer.",
  },
} as const satisfies Record<
  BulkActionIntent,
  {
    label: string;
    didLabel: string;
    didNotLabel: string;
    question: string;
    consequence: string;
  }
>;

export const BULK_VARIANTS: Record<BulkActionIntent, "primary" | undefined | "danger"> = {
  trigger: "primary",
  mark_recovered: undefined,
  cancel: "danger",
};

export function bulkCopy(intent: string) {
  return isBulkActionIntent(intent) ? BULK_INTENTS[intent] : null;
}
