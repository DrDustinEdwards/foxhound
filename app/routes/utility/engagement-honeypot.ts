import { cloudflareContext } from "~/lib/cloudflare-context";
import { recordHoneypot } from "~/lib/engagement/record";
import { verifyEngagementToken } from "~/lib/engagement/token";

import type { Route } from "./+types/engagement-honeypot";

// The honeypot fetch (ROUTES.md: /e/h/:token).
//
// Every dunning email carries one invisible link to this route. No person can
// see it or click it, so a fetch is an automated client following every link in
// the message: an enterprise scanner (SafeLinks, Proofpoint, Mimecast) that
// presents a full browser user agent and therefore walks straight through
// 369's named-bot list. A fetch marks that step's click suspect, so the same
// scanner's fetch of the REAL link cannot bill the merchant.
//
// IT ANSWERS EXACTLY LIKE THE PIXEL, and that matters. Anything distinguishable
// (a 404, a delay, a different body) tells a scanner author which link is the
// trap, and the trap is only useful while it looks like the others.
//
// NO BOT CLASSIFICATION HERE. The click route skips automated agents before
// recording, because a recorded click is a billable event. This is the
// opposite: the whole point is that something automated fetched it, so every
// fetch counts and none is filtered.

const TRANSPARENT_GIF = Uint8Array.from([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00,
  0xff, 0xff, 0xff, 0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b,
]);

function pixel(): Response {
  return new Response(TRANSPARENT_GIF, {
    status: 200,
    headers: {
      "Content-Type": "image/gif",
      "Cache-Control": "no-store, no-cache, must-revalidate, private",
    },
  });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const payload = await verifyEngagementToken(env, params.token ?? "");
  // An unverifiable token answers identically. A different response would be a
  // probe oracle for which tokens are real.
  if (!payload || payload.kind !== "honeypot") return pixel();

  await recordHoneypot(env, payload);
  return pixel();
}
