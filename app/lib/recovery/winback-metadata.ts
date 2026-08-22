// The Checkout Session metadata keys that tie a reactivation back to its
// sequence (344 binding 1). Kept in their own module, with no Stripe import, so
// the webhook CLASSIFIER and the Checkout CREATOR read one definition and
// cannot drift apart. That is 316's shared-predicate rule: the writer and the
// reader of a gate are the same constant or they will eventually disagree.
//
// Legacy has no equivalent. It matches a reactivation on
// (account_id, stripe_customer_id, status='active') and nothing else
// (route.ts:566-573), so a customer holding two subscriptions who cancels one
// and then pays the other's ordinary renewal is credited as a win-back. These
// keys are that same intent expressed exactly, class (c).

export const WINBACK_SEQUENCE_METADATA_KEY = "win_back_sequence_id";
export const WINBACK_STEP_METADATA_KEY = "win_back_step_number";

/** Read the sequence id out of a Stripe metadata bag. Pure, and tolerant of the
 *  three shapes Stripe hands back: absent, present-but-empty, and set. */
export function readWinbackSequenceId(
  metadata: Record<string, string> | null | undefined,
): string | null {
  const value = metadata?.[WINBACK_SEQUENCE_METADATA_KEY];
  return value ? value : null;
}
