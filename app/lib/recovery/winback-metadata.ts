// The Checkout Session metadata keys that tie a reactivation back to its sequence.

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
