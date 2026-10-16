import { getDb } from "~/db";
import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { readEvidenceFile } from "~/lib/disputes/evidence-files.server";

import type { Route } from "./+types/file";

// /disputes/:id/files/:fileId (J07): one merchant evidence file, served by the
// Worker. Recova's evidence-url route (57ccef71) checked the key's account
// prefix and that an evidence row named it, then handed back a one-hour signed
// S3 URL; Foxhound's bucket is a Worker binding with no signed URLs, so the
// Worker checks the row under the signed-in account and this dispute and
// streams the object itself. The file is someone's customer data: never
// cached, never sniffed into another type, and sandboxed so a PDF or image
// served from this origin can run nothing.

export async function loader({ context, params }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const result = await readEvidenceFile(getDb(env), env.EVIDENCE, {
    accountId: auth.membership.accountId,
    disputeId: params.id,
    evidenceId: params.fileId,
  });
  if (result.outcome === "uploads_unavailable") {
    return Response.json(
      { error: "uploads_unavailable" },
      { status: 503, headers: { "Cache-Control": "private, no-store" } },
    );
  }
  if (result.outcome === "not_found") {
    return Response.json({ error: "not_found" }, { status: 404, headers: { "Cache-Control": "private, no-store" } });
  }
  return new Response(result.body, {
    headers: {
      "Content-Type": result.contentType,
      "Content-Disposition": `inline; filename="${result.name.replace(/[^A-Za-z0-9._-]/g, "")}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
    },
  });
}
