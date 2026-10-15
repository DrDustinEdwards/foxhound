/**
 * The reply-to address on a connection (J03), in a CLIENT-SAFE module for the
 * same reason as ./sender-name.ts: the form renders `maxLength` from it, and a
 * `.server` import would ship drizzle into that route's client chunk.
 *
 * LEGACY HAS NO SERVER CHECK: `EmailSection.tsx` renders `type="email"` and
 * `settings/update/route.ts` writes `formData.get('reply_to_email')?.toString()
 * || null`. The browser's `type="email"` is legacy's only guard; this adds the
 * same guard on the server plus a bound, recorded as input hygiene for Dustin
 * rather than a port.
 *
 * It is not decoration: the value becomes the Reply-To header of every
 * merchant-customer email, so a value with a line break would be a header
 * injection, and a value that is not one address would send a customer's reply
 * nowhere. 254 is the longest address SMTP can carry (RFC 5321 4.5.3.1.3).
 */
export const REPLY_TO_EMAIL_MAX_LENGTH = 254;

/** One address, no whitespace or control characters (C0, DEL and C1), a dot
 *  in the domain.
 *  The browser's `type="email"` rule, roughly, checked again on the server. */
// eslint-disable-next-line no-control-regex -- refusing control characters is the point
const SHAPE = /^[^\s\x00-\x1f\x7f-\x9f@<>()",;:\\[\]]+@[^\s\x00-\x1f\x7f-\x9f@<>()",;:\\[\]]+\.[^\s\x00-\x1f\x7f-\x9f@<>()",;:\\[\]]+$/;

export function isValidReplyToEmail(value: string): boolean {
  return value.length <= REPLY_TO_EMAIL_MAX_LENGTH && SHAPE.test(value);
}
