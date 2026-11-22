// The one redactor (pure). A bearer key is meant to be pasted into a third-party agent the merchant does not control, so
// it does not carry customer names or email addresses out of Foxhound: tools return the customer id and a masked email
// for correlation, with every count, amount, state and date intact. The redaction is narrow on purpose: identity,
// reachability and location (`customerIp`, `billingAddress`) are IN; purchase history and Foxhound's own generated text
// (`priorChargesJson`, `recoveryEmailsJson`, `aiResponseText`) are OUT, because they are facts about the merchant's
// relationship with a customer, and are kept off the wire by the tool that would return them.
// The rule is structural, applied at the tool return boundary: `defineToolRegistry` wraps every executor in
// `redactToolResult`, which walks whatever the tool returned and redacts every listed field at any depth. A tool never
// calls it, so it cannot forget, and an unregistered tool is not callable. This is the one authority: no per-tool
// helpers alongside it, since two places applying one rule drift.

/** What the rule does to a field it owns: `drop` is null; `mask-email` keeps the first character and the domain (worth
 *  keeping for correlation; nothing else listed has a use the Stripe customer id does not serve). */
type RedactionRule = "drop" | "mask-email";

/** The fields the rule removes and the treatment of each; the walk below holds no field name of its own, so adding or
 *  removing one here is the whole edit. `customerPhone` is listed against a column that does not exist yet, so a helper
 *  that starts returning one is redacted from day one. A merchant's OWN `notificationEmail` and `senderName` are not
 *  listed and come through whole: it is their settings read back by their own key. */
const REDACTED_CUSTOMER_FIELDS: Readonly<Record<string, RedactionRule>> = {
  customerName: "drop",
  customerEmail: "mask-email",
  customerPhone: "drop",
  customerIp: "drop",
  billingAddress: "drop",
};

/** The rules as a Map: a plain object lookup walks the prototype chain, so a field named `constructor` or `toString`
 *  would read as having a rule and be nulled. */
const RULES = new Map<string, RedactionRule>(Object.entries(REDACTED_CUSTOMER_FIELDS));

/** Mask an email to its first character and domain (`alice@example.com` -> `a***@example.com`). A malformed address
 *  (no `@`) is fully redacted: returning it unchanged would be a path where a raw value escapes. */
export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return "***";
  return `${email[0]}***${email.slice(at)}`;
}

/** Mask a value that arrived in the email field whatever it is: the boundary walks untyped data, so a number, object or
 *  array there is fully masked, the one answer that cannot leak. Null and undefined stay null. */
function maskUnknownEmail(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return "***";
  return maskEmail(value);
}

/** Redact every customer field in a tool's return value, at any depth: returns the whole result rebuilt with listed
 *  fields replaced and everything else copied untouched (a walk, not a picker, so a new non-PII field needs no edit
 *  here while a new PII field is a deliberate decision in REDACTED_CUSTOMER_FIELDS). It recurses because results are
 *  containers and rows can be two deep. Dates are returned as they are: spreading one yields `{}`. `seen` maps original
 *  to REDACTED output, so a cycle or shared subtree returns the redacted copy and never fails open. */
export function redactToolResult(
  value: unknown,
  seen: WeakMap<object, unknown> = new WeakMap(),
): unknown {
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
      // A redacted field is replaced with null, never deleted, so "redacted" is not mistaken for "the helper forgot". The
      // redacted value is never walked: a nested raw value must not survive its parent being removed.
      out[key] = rule === "mask-email" ? maskUnknownEmail(item) : null;
      continue;
    }
    out[key] = redactToolResult(item, seen);
  }
  return out;
}

/** An email address anywhere in free text. Deliberately loose: a false match masks a little too much, a miss would leak. */
const EMAIL_IN_TEXT = /[^\s@'"<>(),;:]+@[^\s@'"<>(),;:]+\.[^\s@'"<>(),;:]+/g;

/** Mask every email address inside a sentence by the same rule. For error text, which the field walk never sees: a
 *  refusal can echo the agent's input. Names cannot be found in free text, so ./server.ts never sends an unexpected
 *  error's text at all. */
export function maskEmailsInText(text: string): string {
  return text.replace(EMAIL_IN_TEXT, (match) => maskEmail(match) ?? "***");
}
