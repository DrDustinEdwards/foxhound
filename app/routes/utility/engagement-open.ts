import { cloudflareContext } from "~/lib/cloudflare-context";
import { classifyEngagementRequest } from "~/lib/engagement/agents";
import { recordOpen } from "~/lib/engagement/record";
import { verifyEngagementToken } from "~/lib/engagement/token";
import { TOKEN_LINK_DIRECTIVE } from "~/lib/http/cache-policy";

import type { Route } from "./+types/engagement-open";

// Engagement open pixel (ROUTES.md: /e/o/:token). A verified token from a person
// records the open (feeds Intelligence only, never billing): one idempotent
// engagement_events row per step, and on the step Recova's per-open counters
// (buildOpenStamp, row F9). We ALWAYS return the
// 1x1 pixel, even on a bad/missing token, so nothing about validity leaks and the
// email renders cleanly.

// 1x1 fully transparent GIF89a.
const PIXEL = Uint8Array.from([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00,
  0xff, 0xff, 0xff, 0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b,
]);

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
    } catch {
      /* swallow */
    }
  }
  return new Response(PIXEL, {
    headers: {
      "Content-Type": "image/gif",
      "Content-Length": String(PIXEL.length),
      "Cache-Control": TOKEN_LINK_DIRECTIVE,
    },
  });
}
