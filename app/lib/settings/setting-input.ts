import { formatCount } from "@drdustinedwards/site-helpers/text";

import { isValidReplyToEmail } from "./reply-to";

// How a setting's raw value, from a form or an MCP tool, is read before
// apply.server.ts validates and writes it.

/** Coerce a JSON or form boolean. Accepts a real boolean and the "true" string
 *  a checkbox posts, so one rule serves both callers. */
export function asBoolean(value: unknown): boolean {
  return value === true || value === "true";
}

/** Trim to null, the shape every optional text setting uses. */
export function asOptionalText(value: unknown): string | null {
  const raw = typeof value === "string" ? value.trim() : "";
  return raw.length > 0 ? raw : null;
}

type Read = { ok: true; value: string | null } | { ok: false; error: string };

/** asOptionalText, or the refusal when the text is over `max`. */
function asBoundedText(value: unknown, max: number, what: string): Read {
  const text = asOptionalText(value);
  if (text && text.length > max) {
    return { ok: false, error: `Keep ${what} under ${formatCount(max)} characters.` };
  }
  return { ok: true, value: text };
}

// The bounds on free text that reaches an email or an AI prompt and has none of its own.
export const asVoice = (value: unknown) => asBoundedText(value, 3000, "a brand voice");
export const asLabel = (value: unknown, what: string) => asBoundedText(value, 200, what);

/** One address, or the refusal: it becomes a mail header's recipient. */
export function asNotificationEmail(value: unknown): Read {
  const email = asOptionalText(value);
  if (email && !isValidReplyToEmail(email)) {
    return { ok: false, error: "Enter a valid notification email address." };
  }
  return { ok: true, value: email };
}
