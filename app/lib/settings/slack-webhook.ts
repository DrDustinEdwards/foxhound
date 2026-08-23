// Slack webhook URL validation for S36.
//
// CLIENT-SAFE, and deliberately not a `.server` module: the page renders the
// message and the placeholder, and 335 binding 6 pinned that a client-facing
// constant imported from a `.server` file breaks the build (it recurred once at
// 336 and the gate caught it).
//
// THIS IS AN ADDITION OVER LEGACY, RATIFIED BY DUSTIN THIS SESSION.
//
// Legacy stores whatever is typed:
//   `accountUpdates.slack_webhook_url = formData.get('slack_webhook_url')?.toString() || null`
// with no parse, no host check and no message. Foxhound then `fetch()`es that
// stored value from the Worker on every dunning email, and nothing in this
// repo constrains outbound egress: `connect-src 'self'` in security-headers.ts
// is a CSP RESPONSE header governing the browser, not the Worker. So an
// unvalidated field is a server-side request primitive pointed at any host a
// merchant types, including internal ones.
//
// The host allowlist closes that. It is a DIVERGENCE from legacy on a
// user-visible surface and is recorded as one.

export const SLACK_WEBHOOK_PREFIX = "https://hooks.slack.com/";

export const SLACK_WEBHOOK_PLACEHOLDER = "https://hooks.slack.com/services/...";

export const SLACK_WEBHOOK_ERROR =
  "Enter a Slack webhook URL starting with https://hooks.slack.com/";

/**
 * Normalize the posted field.
 *
 * An empty box clears the column, which is legacy's `|| null` exactly. A
 * non-empty value must be an https URL on `hooks.slack.com` and nothing else.
 *
 * The check parses rather than pattern-matching the whole string, so a value
 * like `https://hooks.slack.com.evil.test/x` fails on the HOST comparison
 * rather than passing a prefix test.
 */
export function normalizeSlackWebhookUrl(
  raw: string | null | undefined,
): { ok: true; value: string | null } | { ok: false; error: string } {
  const trimmed = (raw ?? "").trim();
  if (trimmed.length === 0) return { ok: true, value: null };

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, error: SLACK_WEBHOOK_ERROR };
  }
  if (url.protocol !== "https:" || url.hostname !== "hooks.slack.com") {
    return { ok: false, error: SLACK_WEBHOOK_ERROR };
  }
  return { ok: true, value: trimmed };
}
