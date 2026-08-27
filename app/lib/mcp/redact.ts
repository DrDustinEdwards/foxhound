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
// THE APPLICATION POINT MOVED IN SESSION 83, AND THAT IS THE WHOLE FIX (376
// item 7). 370 scoped the rule to three tools that each called a helper on the
// way out, so the redaction was a thing a tool REMEMBERED to do. Three tools
// forgot: `list_disputes` returned `db.select()` over a table carrying a name
// and an email, and `get_churn` and `get_intelligence_overview` passed views
// carrying `customerName` straight through. Meanwhile the published copy on
// /docs and llms.txt promised the endpoint redacts, with no per-tool
// qualification. The promise was right and the scope was wrong.
//
// SO THE RULE IS NOW STRUCTURAL AND APPLIES AT THE TOOL RETURN BOUNDARY.
// `defineToolRegistry` wraps every executor it registers in `redactToolResult`,
// which walks whatever the tool returned and redacts the two fields wherever
// they appear, at any depth. A tool cannot skip it, because a tool never calls
// it: registration is what applies it, and an unregistered tool is not callable.
// A new tool written next year by somebody who never reads this file is covered
// on the day it is registered.
//
// ONE AUTHORITY, NOT TWO (381 binding e). The per-tool helpers this file used to
// export are GONE rather than kept alongside the boundary. Two places applying
// one rule is two places for it to drift, and a plant that mutates one while the
// other silently holds the assertion up is a guard proving nothing.

/**
 * The two field names the rule removes, as the wire spells them.
 *
 * NAMING THEM IS THE ALLOWLIST, and the codebase earns that: `customerName` and
 * `customerEmail` are the only spellings any helper uses for these two values,
 * measured across app/lib. The narrowness is deliberate in the other direction
 * too. A merchant's OWN address arrives at the endpoint as `notificationEmail`
 * and `senderName` and must come through whole, because it is the merchant's
 * own settings value being read back by the merchant's own key; masking it
 * would break the settings readers to protect nobody.
 */
export const REDACTED_CUSTOMER_FIELDS = ["customerName", "customerEmail"] as const;

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
 * Mask a value that ARRIVED IN THE EMAIL FIELD, whatever it turned out to be.
 *
 * The boundary walks untyped data, so the value under `customerEmail` is
 * whatever a helper put there rather than whatever a type says. A number, an
 * object or an array in that field is a shape nobody predicted, and the one
 * answer that cannot leak is the fully masked one. Null and undefined stay
 * null, because absence is not a value to hide.
 */
function maskUnknownEmail(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return "***";
  return maskEmail(value);
}

/**
 * Redact every customer field in a tool's return value, at any depth.
 *
 * TAKES THE WHOLE RESULT AND RETURNS THE WHOLE RESULT, rebuilt with the two
 * fields replaced and everything else copied through untouched. Written as a
 * walk rather than as a picker so a tool that gains a new NON-PII field keeps
 * returning it without anyone editing this file, while a tool that gains a new
 * PII field is a decision somebody has to make deliberately here.
 *
 * WHY IT RECURSES rather than checking the top level. A tool result is a
 * container: `{ customers: [...] }`, `{ disputes: [...] }`, `{ topAtRisk: [...]
 * }`, and `get_churn` buries its rows two deep. A top-level check would have
 * passed every one of the three tools that were leaking.
 *
 * DATES ARE RETURNED AS THEY ARE, deliberately. Spreading a Date yields an empty
 * object, which would have turned every `createdAt` on the endpoint into `{}`
 * and been a data-loss bug shipped by a privacy fix.
 *
 * The `seen` map keeps a cycle from recursing forever and makes a shared
 * subtree redact once. It maps original to REDACTED output, so revisiting a node
 * returns the redacted copy rather than the raw one: a cycle must not be the
 * path where the rule fails open.
 */
export function redactToolResult(value: unknown, seen: WeakMap<object, unknown> = new WeakMap()): unknown {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value;

  const node = value as object;
  if (seen.has(node)) return seen.get(node);

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    seen.set(node, out);
    for (const item of value) out.push(redactToolResult(item, seen));
    return out;
  }

  const out: Record<string, unknown> = {};
  seen.set(node, out);
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === "customerName") {
      // ALWAYS null, and present rather than deleted, so a consumer that expects
      // the field gets an explicit null instead of undefined and cannot mistake
      // "redacted" for "the helper forgot".
      out[key] = null;
      continue;
    }
    if (key === "customerEmail") {
      out[key] = maskUnknownEmail(item);
      continue;
    }
    out[key] = redactToolResult(item, seen);
  }
  return out;
}
