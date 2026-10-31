import { receiveCspReport } from "@dustinedwards/site-runtime/csp-report";

import { cloudflareContext } from "~/lib/cloudflare-context";
import { RATE_LIMIT_CSP_REPORT } from "~/lib/constants";
import { isWithinRateLimit } from "~/lib/http/rate-limit";

import type { Route } from "./+types/csp-report";

// POST /csp-report: the Content-Security-Policy report sink. The policy
// (lib/http/content-security-policy.ts) names it by report-uri and by report-to.
// site-runtime's receiver reads and answers it; Foxhound logs less than it would.
//
// WHAT IS LOGGED: the directive, the disposition, and the blocked resource as
// its ORIGIN only, or a CSP keyword. Never a path, never the page: for
// frame-ancestors and navigation violations the blocked URL is a Foxhound
// page, and /u/, /p/ and /e/c/ paths carry one person's token.
//
// The per-IP `csp-report` bucket fails open: a limiter outage costs only log lines.

function originOnly(value: unknown): string {
  if (typeof value !== "string" || value === "") return "unknown";
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : url.protocol;
  } catch {
    return /^[a-z-]+$/i.test(value) ? value : "unknown";
  }
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  return receiveCspReport(request, {
    allow: (r) =>
      isWithinRateLimit(
        env,
        "csp-report",
        r.headers.get("cf-connecting-ip") ?? "unknown",
        RATE_LIMIT_CSP_REPORT.max,
        RATE_LIMIT_CSP_REPORT.windowMs,
      ),
    log: (line) =>
      console.info(
        JSON.stringify({
          event: "csp_violation",
          directive: line.directive ?? "unknown",
          blocked: originOnly(line.blocked),
          disposition: line.disposition ?? "unknown",
        }),
      ),
  });
}
