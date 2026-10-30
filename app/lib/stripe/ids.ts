// Stripe returns a related object either expanded or as its bare id string,
// depending on the call's `expand`. One reader for both shapes.

/** The id of a Stripe field that may arrive expanded or as a bare string, or
 *  null when the field is absent. */
export function asId(ref: string | { id?: string } | null | undefined): string | null {
  if (!ref) return null;
  return typeof ref === "string" ? ref : (ref.id ?? null);
}
