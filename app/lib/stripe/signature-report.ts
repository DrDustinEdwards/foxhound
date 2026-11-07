import * as Sentry from "@sentry/cloudflare";
import { logEvent } from "@dustinedwards/site-runtime/log";

import { isWithinRateLimit } from "~/lib/http/rate-limit";

const SIGNATURE_REPORTS_PER_HOUR = 5;

/**
 * A webhook whose signature failed. A secret-rotation slip stops payment ingestion, so make it visible;
 * but the endpoints are public and every junk POST lands here too. Report at most
 * SIGNATURE_REPORTS_PER_HOUR an hour per endpoint across the whole Worker (one shared key, so no caller
 * can spread around it): enough to show a rotation slip, not enough to spend the Sentry quota or bury
 * real alerts. The rest go to the Workers log only. The context carries no secret material.
 */
export async function reportBadSignature(
  env: Env,
  endpoint: string,
  err: unknown,
  hasSignature: boolean,
): Promise<void> {
  const scope = `${endpoint}-signature`;
  if (await isWithinRateLimit(env, "sentry", scope, SIGNATURE_REPORTS_PER_HOUR, 3_600_000)) {
    Sentry.captureException(err, { extra: { scope, hasSignature } });
  } else {
    logEvent("stripe_webhook_signature_invalid", { endpoint, reported: false }, { level: "warn" });
  }
}
