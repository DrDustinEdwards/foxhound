import { cloudflareContext } from "~/lib/cloudflare-context";
import { recordOpen } from "~/lib/engagement/record";
import { verifyEngagementToken } from "~/lib/engagement/token";

import type { Route } from "./+types/engagement-open";

// Engagement open pixel (ROUTES.md: /e/o/:token). A verified token records an
// idempotent open (feeds Intelligence only, never billing). We ALWAYS return the
// 1x1 pixel, even on a bad/missing token, so nothing about validity leaks and the
// email renders cleanly.

// 1x1 fully transparent GIF89a.
const PIXEL = Uint8Array.from([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00,
  0xff, 0xff, 0xff, 0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b,
]);

export async function loader({ params, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const payload = params.token ? await verifyEngagementToken(env, params.token) : null;
  if (payload && payload.kind === "open") {
    // Best-effort: a tracking write must never fail the pixel response.
    try {
      await recordOpen(env, payload);
    } catch {
      /* swallow */
    }
  }
  return new Response(PIXEL, {
    headers: {
      "Content-Type": "image/gif",
      "Content-Length": String(PIXEL.length),
      "Cache-Control": "no-store, no-cache, must-revalidate, private",
    },
  });
}
