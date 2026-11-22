/**
 * The reply-to address on a connection, in a CLIENT-SAFE module for the same reason as
 * ./sender-name.ts: the form renders `maxLength` from it, and a `.server` import would ship drizzle
 * into that route's client chunk.
 */
export const REPLY_TO_EMAIL_MAX_LENGTH = 254;

/** One address, no whitespace or control characters, a dot in the domain. */
const SHAPE =
  // oxlint-disable-next-line no-control-regex -- refusing control characters is the point
  /^[^\s\x00-\x1f\x7f-\x9f@<>()",;:\\[\]]+@[^\s\x00-\x1f\x7f-\x9f@<>()",;:\\[\]]+\.[^\s\x00-\x1f\x7f-\x9f@<>()",;:\\[\]]+$/;

export function isValidReplyToEmail(value: string): boolean {
  return value.length <= REPLY_TO_EMAIL_MAX_LENGTH && SHAPE.test(value);
}
