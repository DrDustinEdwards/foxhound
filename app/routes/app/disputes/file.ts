import { buildPolicy } from "@dustinedwards/site-runtime/csp";
import { UPLOAD_HEADERS } from "@dustinedwards/site-runtime/headers";

import { getDb } from "~/db";
import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { readEvidenceFile } from "~/lib/disputes/evidence-files.server";

import type { Route } from "./+types/file";

// /disputes/:id/files/:fileId: one merchant evidence file, served by the
// Worker. Recova's evidence-url route (57ccef71) checked the key's account
// prefix and that an evidence row named it, then handed back a one-hour signed
// S3 URL; Foxhound's bucket is a Worker binding with no signed URLs, so the
// Worker checks the row under the signed-in account and this dispute and
// streams the object itself. The file is someone's customer data: never
// cached (the one cache policy, app/lib/http/cache-policy.ts, makes this path
// private, no-store, so the route sets no header of its own), never sniffed
// into another type, and inert: site-runtime's UPLOAD_HEADERS (nosniff and a
// sandboxed policy that loads nothing), except a PDF's policy below.

/** A PDF needs the browser's own viewer, which a sandboxed document is refused
 *  (Chrome will not run its viewer in one), so the PDF policy allows only that
 *  viewer's embed of this same response and nothing else. */
const PDF_POLICY = buildPolicy(["default-src 'none'", "object-src 'self'", "style-src 'unsafe-inline'", "frame-ancestors 'none'"]);

export async function loader({ context, params }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const result = await readEvidenceFile(getDb(env), env.EVIDENCE, {
    accountId: auth.membership.accountId,
    disputeId: params.id,
    evidenceId: params.fileId,
  });
  if (result.outcome === "uploads_unavailable") {
    return Response.json({ error: "uploads_unavailable" }, { status: 503 });
  }
  if (result.outcome === "not_found") {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  return new Response(result.body, {
    headers: {
      ...UPLOAD_HEADERS,
      ...(result.contentType === "application/pdf" ? { "Content-Security-Policy": PDF_POLICY } : {}),
      "Content-Type": result.contentType,
      "Content-Disposition": `inline; filename="${result.name.replace(/[^A-Za-z0-9._-]/g, "")}"`,
    },
  });
}
