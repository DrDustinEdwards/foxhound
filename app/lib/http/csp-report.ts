// The CSP report sink's reader (J22, F16). site-runtime's policy builder
// refuses a policy with no sink, because a blocked script nobody hears about is
// how the hydration outage in TASK-foxhound-csp-nonce-hydration.md stayed live.
// Recova had the same endpoint (app/api/csp-report/route.ts), forwarding to
// Sentry with the page URL and the full report; Foxhound logs one structured
// line per violation to Workers Logs instead, with less in it.
//
// WHAT IS KEPT: the directive, the disposition, and the blocked resource as
// its ORIGIN only, or a CSP keyword ("inline", "eval"). Never a path and never
// a query string, and the page URL not at all: for frame-ancestors and
// navigation violations the blocked URL is a Foxhound page, and /u/, /p/ and
// /e/c/ paths carry one person's token (RULES.md 3.5); a sign-in page's query
// can carry an address.

/** The most bytes of one report body that are read; the rest is refused. */
export const CSP_REPORT_MAX_BYTES = 16 * 1024;

/** The most violations one request may log. A 16 KB batch holds about 150,
 *  and one browser bug should cost five log lines, not a page of them. */
export const CSP_REPORT_MAX_LOGGED = 5;

export type CspViolation = { directive: string; blocked: string; disposition: string };

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, 200) : null;
}

function blockedResource(raw: string | null): string {
  if (!raw) return "unknown";
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : url.protocol;
  } catch {
    // A keyword such as "inline", "eval" or "self", never a URL.
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

/**
 * The body as text, read chunk by chunk with a running byte count, or null as
 * soon as it passes `maxBytes`. Content-Length is only a hint: a chunked body
 * has none, and request.text() would buffer all of it before any check.
 */
export async function readCapped(request: Request, maxBytes: number): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}
