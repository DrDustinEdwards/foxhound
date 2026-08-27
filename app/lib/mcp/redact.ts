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
// SO THE REDACTION IS NARROW ON PURPOSE. It removes IDENTITY, REACHABILITY and
// LOCATION, and nothing else. An agent can still tell you which customer is at
// risk, how much they are worth, when they last paid and what failed; it cannot
// tell you who they are, write to them, or say where they were. That is the line
// between an agent that helps a merchant reason and an agent that has quietly
// exported a customer list.
//
// LOCATION JOINED THE SET AT 383, and the boundary of the ruling is worth
// stating because session 83 asked the question the wrong way round. `customerIp`
// and `billingAddress` are IN: an address is more reachable than an email and an
// IP is where somebody was. Purchase history and Foxhound's own generated text
// are OUT: `priorChargesJson`, `recoveryEmailsJson` and `aiResponseText` are
// facts about the MERCHANT'S RELATIONSHIP with a customer rather than about the
// person, and a redactor that started nulling them would be deciding what a
// merchant may read about their own business. Those are kept off the wire by the
// tool that would otherwise return them, not by this file.
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
// which walks whatever the tool returned and redacts every listed field wherever
// they appear, at any depth. A tool cannot skip it, because a tool never calls
// it: registration is what applies it, and an unregistered tool is not callable.
// A new tool written next year by somebody who never reads this file is covered
// on the day it is registered.
//
// ONE AUTHORITY, NOT TWO (381 binding e). The per-tool helpers this file used to
// export are GONE rather than kept alongside the boundary. Two places applying
// one rule is two places for it to drift, and a plant that mutates one while the
// other silently holds the assertion up is a guard proving nothing.

/** What the rule does to a field it owns. `drop` is null, `mask-email` keeps the
 *  first character and the domain. Two treatments, because 370 ruled a masked
 *  address is worth keeping for correlation and nothing else on this list has a
 *  correlation use the Stripe customer id does not already serve. */
type RedactionRule = "drop" | "mask-email";

/**
 * THE FIELDS THE RULE REMOVES AND WHAT IT DOES TO EACH. This constant is the
 * authority (383): the walk below reads it and contains no field name of its
 * own, so adding or removing a field here is the whole edit, and a field removed
 * here is genuinely unprotected, which is what makes the plant meaningful.
 *
 * NAMING THEM IS THE ALLOWLIST, and the codebase earns that: measured across
 * app/ and workers/, these are the only spellings in use, and `customerIp` and
 * `billingAddress` exist on exactly one table (`disputes`).
 *
 * `customerPhone` IS LISTED AGAINST A COLUMN THAT DOES NOT EXIST, deliberately
 * and on 383's instruction. No table carries a phone today. Listing it now costs
 * one line and means the day a helper starts returning one, it is redacted
 * before anybody notices it shipped, rather than after. A rule that only covers
 * the columns that exist is a rule that fails on the next migration.
 *
 * THE NARROWNESS IS DELIBERATE IN THE OTHER DIRECTION TOO. A merchant's OWN
 * address arrives at the endpoint as `notificationEmail` and `senderName` and
 * must come through whole, because it is the merchant's own settings value being
 * read back by the merchant's own key; masking it would break the settings
 * readers to protect nobody.
 */
export const REDACTED_CUSTOMER_FIELDS: Readonly<Record<string, RedactionRule>> = {
  customerName: "drop",
  customerEmail: "mask-email",
  customerPhone: "drop",
  customerIp: "drop",
  billingAddress: "drop",
};

/**
 * The same rules as a Map, built once at module load.
 *
 * A MAP RATHER THAN THE OBJECT ITSELF, and this is a correctness fix rather than
 * a style choice: a plain object lookup walks the prototype chain, so a tool
 * returning a field named `constructor` or `toString` would find a function
 * there, read as "this field has a rule", and be nulled. A Map has no prototype
 * chain to inherit from, so only the five names above match.
 */
const RULES = new Map<string, RedactionRule>(Object.entries(REDACTED_CUSTOMER_FIELDS));

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
 * TAKES THE WHOLE RESULT AND RETURNS THE WHOLE RESULT, rebuilt with every listed
 * field replaced and everything else copied through untouched. Written as a
 * walk rather than as a picker so a tool that gains a new NON-PII field keeps
 * returning it without anyone editing this file, while a tool that gains a new
 * PII field is a decision somebody has to make deliberately, in
 * REDACTED_CUSTOMER_FIELDS and nowhere else.
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
    const rule = RULES.get(key);
    if (rule !== undefined) {
      // A REDACTED FIELD IS REPLACED, NEVER DELETED, so a consumer that expects
      // the field gets an explicit null instead of undefined and cannot mistake
      // "redacted" for "the helper forgot". The redacted value is never walked:
      // there is nothing under a dropped field worth recursing into, and
      // recursing would be the one path where a nested raw value survives its
      // own parent being removed.
      out[key] = rule === "mask-email" ? maskUnknownEmail(item) : null;
      continue;
    }
    out[key] = redactToolResult(item, seen);
  }
  return out;
}
