import { CSP_REPORT_MAX_BYTES, summariseCspReport } from "~/lib/http/csp-report";

import type { Route } from "./+types/csp-report";

// POST /api/csp-report: the Content-Security-Policy report sink (J22, F16),
// at Recova's own path. The policy (lib/http/content-security-policy.ts) names
// it by report-uri and by report-to through the Reporting-Endpoints header.
//
// ACTION ONLY, like api/theme.ts: a GET is answered by React Router with 400
// because there is no loader. Browsers ignore the answer, so a malformed body
// gets 204 as on Recova ("browsers occasionally send malformed reports"); a
// body over the cap gets 413 and is not parsed. Nothing here touches the
// database, a session or the network: one structured log line per violation.
export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }

  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > CSP_REPORT_MAX_BYTES) return new Response(null, { status: 413 });
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > CSP_REPORT_MAX_BYTES) return new Response(null, { status: 413 });

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return new Response(null, { status: 204 });
  }

  for (const violation of summariseCspReport(body)) {
    console.log(JSON.stringify({ event: "csp_violation", ...violation }));
  }
  return new Response(null, { status: 204 });
}
