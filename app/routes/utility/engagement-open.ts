import { logEvent } from "@dustinedwards/site-runtime/log";

import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import { classifyEngagementRequest } from "~/lib/engagement/agents";
import { pixelResponse } from "~/lib/engagement/pixel";
import { recordOpen } from "~/lib/engagement/record";
import { verifyEngagementToken } from "~/lib/engagement/token";

import type { Route } from "./+types/engagement-open";

// Engagement open pixel (/e/o/:token). A verified token from a person records the open (feeds Intelligence only, never billing): one idempotent engagement_events row per step, and the step's per-open counters (buildOpenStamp). The 1x1 pixel is ALWAYS returned, even on a bad or missing token, so nothing about validity leaks and the email renders cleanly.

export async function loader({ params, request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const payload = params.token ? await verifyEngagementToken(env, params.token) : null;
  if (payload && payload.kind === "open") {
    // Best-effort: a tracking write must never fail the pixel response.
    // The pixel is returned identically either way; only the write is gated.
    const source = classifyEngagementRequest(request, "open");
    try {
      const result = await recordOpen(env, payload, source);
      if (!result.recorded) console.debug("engagement open skipped:", result.reason);
    } catch (err) {
      // Still best-effort for the customer, who gets the same response, but a failed write loses an open from Intelligence, so it must be seen, not swallowed. The step id is enough to trace it; the token stays out.
      logEvent(
        "engagement_open_failed",
        { stepId: payload.stepId, error: err },
        { level: "error" },
      );
    }
  }
  return pixelResponse();
}
