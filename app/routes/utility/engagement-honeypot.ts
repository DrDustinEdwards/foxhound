import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import { pixelResponse } from "~/lib/engagement/pixel";
import { recordHoneypot } from "~/lib/engagement/record";
import { verifyEngagementToken } from "~/lib/engagement/token";

import type { Route } from "./+types/engagement-honeypot";

// The honeypot fetch (/e/h/:token). Every dunning email carries one invisible link to this route. No person can see it or click it, so a fetch is an automated client following every link in the message: an enterprise scanner (SafeLinks, Proofpoint, Mimecast) that presents a full browser user agent and so walks straight through the named-bot list. A fetch marks that step's click suspect, so the same scanner's fetch of the REAL link cannot bill the merchant.
// IT ANSWERS EXACTLY LIKE THE PIXEL: anything distinguishable (a 404, a delay, a different body) tells a scanner author which link is the trap.
// NO BOT CLASSIFICATION HERE. The click route skips automated agents before recording, because a recorded click is a billable event; this is the opposite: every fetch counts and none is filtered.

export async function loader({ params, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const payload = await verifyEngagementToken(env, params.token ?? "");
  // An unverifiable token answers identically. A different response would be a
  // probe oracle for which tokens are real.
  if (!payload || payload.kind !== "honeypot") return pixelResponse();

  await recordHoneypot(env, payload);
  return pixelResponse();
}
