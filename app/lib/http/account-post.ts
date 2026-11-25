import { readForm, readJson } from "@dustinedwards/site-runtime/body";
import { refuseCrossSite } from "@dustinedwards/site-runtime/origin";

import { DEMO_READ_ONLY_MESSAGE } from "~/lib/demo/constants";
import { hasDemoCookie } from "~/lib/demo/session";
import { BODY_MAX_BYTES } from "~/lib/http/body";

/**
 * The refusals every action-only /api route starts with: cross-site, a verb
 * other than POST (React Router already answers a GET with 400), and, with
 * `demo`, a demo session before any session or database work (hard rule 10).
 */
export function refusePost(request: Request, options: { demo?: boolean } = {}): Response | null {
  const refused = refuseCrossSite(request);
  if (refused) return refused;
  if (request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }
  if (options.demo && hasDemoCookie(request)) {
    return Response.json({ error: DEMO_READ_ONLY_MESSAGE }, { status: 405 });
  }
  return null;
}

/** The posted account id, from a JSON body (a fetch) or a form (works without JavaScript). */
export async function readAccountId(request: Request): Promise<string | null> {
  try {
    let value: unknown;
    if ((request.headers.get("content-type") ?? "").includes("application/json")) {
      value = ((await readJson(request, BODY_MAX_BYTES)) as { accountId?: unknown } | null)
        ?.accountId;
    } else {
      value = (await readForm(request, BODY_MAX_BYTES)).get("accountId");
    }
    return typeof value === "string" && value ? value : null;
  } catch (error) {
    if (error instanceof Response) throw error;
    return null;
  }
}
