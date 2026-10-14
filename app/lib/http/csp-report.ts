// The CSP report sink's reader (J22, F16). site-runtime's policy builder
// refuses a policy with no sink, because a blocked script nobody hears about is
// how the hydration outage in TASK-foxhound-csp-nonce-hydration.md stayed live.
// Recova had the same endpoint (app/api/csp-report/route.ts), forwarding to
// Sentry with the page URL and the full report; Foxhound logs one structured
// line per violation to Workers Logs instead, with less in it.
//
// WHAT IS KEPT: the directive, the disposition, and the blocked resource as
// origin plus path, or a CSP keyword ("inline", "eval"). The page URL is never
// kept and neither is a query string: /u/, /p/ and /e/c/ links carry one
// person's token (RULES.md 3.5), and a sign-in page can carry an address.

export const CSP_REPORT_MAX_BYTES = 16 * 1024;

export type CspViolation = { directive: string; blocked: string; disposition: string };

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, 200) : null;
}

function blockedResource(raw: string | null): string {
  if (!raw) return "unknown";
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? `${url.origin}${url.pathname}` : url.protocol;
  } catch {
    // A keyword such as "inline", "eval" or "self", never a URL with a query.
    return /^[a-z-]+$/i.test(raw) ? raw : "unknown";
  }
}

function one(report: Record<string, unknown>): CspViolation {
  return {
    directive: text(report["effective-directive"]) ?? text(report["violated-directive"]) ?? text(report.effectiveDirective) ?? "unknown",
    blocked: blockedResource(text(report["blocked-uri"]) ?? text(report.blockedURL)),
    disposition: text(report.disposition) ?? "unknown",
  };
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** The violations in a report body: the report-uri shape or a Reporting API batch. */
export function summariseCspReport(body: unknown): CspViolation[] {
  if (Array.isArray(body)) {
    return body
      .filter((entry): entry is Record<string, unknown> => isObject(entry) && entry.type === "csp-violation" && isObject(entry.body))
      .map((entry) => one(entry.body as Record<string, unknown>));
  }
  if (isObject(body) && isObject(body["csp-report"])) return [one(body["csp-report"])];
  return [];
}
