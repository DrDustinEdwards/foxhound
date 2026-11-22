// Slack webhook URL validation for S36. Foxhound then `fetch()`es that stored value from the Worker
// on every dunning email, and nothing in this repo constrains outbound egress: `connect-src 'self'`
// in content-security-policy.ts is a CSP RESPONSE header governing the browser, not the Worker.

export const SLACK_WEBHOOK_PLACEHOLDER = "https://hooks.slack.com/services/...";

export const SLACK_WEBHOOK_ERROR =
  "Enter a Slack webhook URL starting with https://hooks.slack.com/";

/**
 * Normalize the posted field. A non-empty value must be an https URL on `hooks.slack.com` and
 * nothing else.
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
  if (
    url.protocol !== "https:" ||
    url.hostname !== "hooks.slack.com" ||
    url.port !== "" ||
    url.username ||
    url.password
  ) {
    return { ok: false, error: SLACK_WEBHOOK_ERROR };
  }
  return { ok: true, value: trimmed };
}
