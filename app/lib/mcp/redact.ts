// THE ONE REDACTOR (370's DEFAULT-REDACT ruling). Pure, so the rule is testable
// without a database, a request or a tool.
//
// WHAT THE RULING SAID AND WHY. Every field this touches is the merchant's own
// customer data, already visible on their own dashboard, so the question was
// never "may the merchant see it". A bearer key is designed to be pasted into a
// third-party agent the merchant does not control, and 370 ruled that such a key
// does not carry customer names or email addresses out of Foxhound by default:
// the tools return the customer id and a masked email sufficient for
// correlation, with every count, amount, state and date intact.
//
// SO THE REDACTION IS NARROW ON PURPOSE. It removes exactly two things, identity
// and reachability, and nothing else. An agent can still tell you which customer
// is at risk, how much they are worth, when they last paid and what failed; it
// cannot tell you their name or write to them. That is the line between an agent
// that helps a merchant reason and an agent that has quietly exported a customer
// list.
//
// ONE IMPLEMENTATION, and the tools import it rather than each masking inline.
// Three tools carry PII and three inline maskers would be three places for the
// rule to drift, with only the one somebody re-read staying correct.

/** What a masked customer looks like on the wire. The id is intact because it is
 *  the correlation key an agent needs to ask a follow-up question about the same
 *  customer, and it is a Stripe identifier rather than a person's identity. */
export interface RedactedCustomer {
  stripeCustomerId: string;
  /** First character plus domain, or null when there was no email. */
  customerEmail: string | null;
  /** ALWAYS null. Present in the shape rather than deleted, so a consumer that
   *  expects the field gets an explicit null instead of undefined and cannot
   *  mistake "redacted" for "the helper forgot". */
  customerName: null;
}

/**
 * Mask an email to its first character and its domain.
 *
 * `alice@example.com` becomes `a***@example.com`. Enough to recognise an address
 * you already know, not enough to send to one you do not.
 *
 * A MALFORMED ADDRESS IS FULLY REDACTED rather than passed through. An input
 * with no `@` cannot be masked by this rule, and returning it unchanged would be
 * the one path where a raw value escapes. Failing closed on the odd case is free
 * here; failing open would be the whole defect.
 */
export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return "***";
  return `${email[0]}***${email.slice(at)}`;
}

/**
 * Apply the default to one customer-shaped row.
 *
 * TAKES THE WHOLE ROW AND RETURNS THE WHOLE ROW, with the two fields replaced
 * and everything else passed through untouched. Written this way rather than as
 * a picker so a helper that gains a new NON-PII field keeps returning it without
 * anyone editing this file, while a helper that gains a new PII field is a
 * decision somebody has to make deliberately.
 */
export function redactCustomerFields<
  T extends { stripeCustomerId: string; customerEmail?: string | null; customerName?: string | null },
>(row: T): Omit<T, "customerEmail" | "customerName"> & RedactedCustomer {
  const { customerEmail, customerName, ...rest } = row;
  void customerName;
  return {
    ...rest,
    stripeCustomerId: row.stripeCustomerId,
    customerEmail: maskEmail(customerEmail),
    customerName: null,
  } as Omit<T, "customerEmail" | "customerName"> & RedactedCustomer;
}

/**
 * The failed-payment shape, which carries a customer email under the same rule
 * but has no name field and keys on `stripeCustomerId` from a different table.
 */
export function redactPaymentFields<
  T extends { stripeCustomerId: string; customerEmail?: string | null },
>(row: T): Omit<T, "customerEmail"> & { stripeCustomerId: string; customerEmail: string | null } {
  const { customerEmail, ...rest } = row;
  return {
    ...rest,
    stripeCustomerId: row.stripeCustomerId,
    customerEmail: maskEmail(customerEmail),
  } as Omit<T, "customerEmail"> & { stripeCustomerId: string; customerEmail: string | null };
}
