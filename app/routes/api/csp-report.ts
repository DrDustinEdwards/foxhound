import { cloudflareContext } from "~/lib/cloudflare-context";
import { RATE_LIMIT_CSP_REPORT } from "~/lib/constants";
import { CSP_REPORT_MAX_BYTES, CSP_REPORT_MAX_LOGGED, readCapped, summariseCspReport } from "~/lib/http/csp-report";
import { isWithinRateLimit } from "~/lib/http/rate-limit";

import type { Route } from "./+types/csp-report";

// POST /api/csp-report: the Content-Security-Policy report sink (J22, F16),
// at Recova's own path. The policy (lib/http/content-security-policy.ts) names
// it by report-uri and by report-to through the Reporting-Endpoints header.
//
// ACTION ONLY, like api/theme.ts: a GET is answered by React Router with 400
// because there is no loader. Browsers ignore the answer, so a malformed body
// and an over-limit caller both get 204, as on Recova ("browsers don't display
// 429 to the user"); a body over the cap gets 413 and is not parsed. Nothing
// here touches the database or a session: one structured log line per
// violation, at most CSP_REPORT_MAX_LOGGED per request.
//
// RATE LIMIT: 311's limiter, used unchanged, through isWithinRateLimit (the
// route reacts to "over" itself, as audit/connect.tsx does) on a per-IP
// `csp-report` bucket. It fails open like every other caller: the worst a
// limiter outage costs here is log lines.
export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }

  const { env } = context.get(cloudflareContext);
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const within = await isWithinRateLimit(env, "csp-report", ip, RATE_LIMIT_CSP_REPORT.max, RATE_LIMIT_CSP_REPORT.windowMs);
  if (!within) return new Response(null, { status: 204 });

  if (Number(request.headers.get("content-length") ?? 0) > CSP_REPORT_MAX_BYTES) {
    return new Response(null, { status: 413 });
  }
  const raw = await readCapped(request, CSP_REPORT_MAX_BYTES);
  if (raw === null) return new Response(null, { status: 413 });

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return new Response(null, { status: 204 });
  }

  for (const violation of summariseCspReport(body).slice(0, CSP_REPORT_MAX_LOGGED)) {
    console.log(JSON.stringify({ event: "csp_violation", ...violation }));
  }
  return new Response(null, { status: 204 });
}
