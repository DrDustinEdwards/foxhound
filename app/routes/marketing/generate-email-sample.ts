import { data, redirect } from "react-router";

import { cloudflareContext } from "~/lib/cloudflare-context";
import { isWithinRateLimit } from "~/lib/http/rate-limit";
import {
  MARKETING_EMAIL_CATEGORIES,
  MARKETING_EMAIL_FALLBACKS,
  type MarketingEmailCategory,
} from "~/lib/marketing/email-sample-fallbacks";
import { generateMarketingEmailSample } from "~/lib/marketing/home-email-sample.server";

import type { Route } from "./+types/generate-email-sample";

// Restores live generation on the home page's email sample widget
// (TASK-foxhound-demo-entry-parity.md item 3): unauthenticated, so abuse
// protection is mandatory. Rate limit is a dedicated bucket checked here in
// the action (not the shared top-level enforceRateLimit path), because the
// required behavior on "over limit" is the same static fallback used on a
// generation failure, never an error surface. Both paths return the exact
// same {subject, body} shape either way, so the client cannot tell, and does
// not need to.
function isValidCategory(value: string): value is MarketingEmailCategory {
  return (MARKETING_EMAIL_CATEGORIES as string[]).includes(value);
}

// POST only. A stray GET (crawler, prefetch) has nothing to render here, so
// it bounces to the home page instead of erroring (same pattern as
// auth/google-start.ts's loader).
export function loader() {
  return redirect("/");
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const form = await request.formData();
  const categoryInput = String(form.get("category") ?? "");
  const category: MarketingEmailCategory = isValidCategory(categoryInput) ? categoryInput : "soft";

  const key = request.headers.get("cf-connecting-ip") ?? "unknown";
  const withinLimit = await isWithinRateLimit(env, "marketing_email_sample", key, 10, 60_000);
  if (!withinLimit) {
    return data(MARKETING_EMAIL_FALLBACKS[category]);
  }

  try {
    const copy = await generateMarketingEmailSample(env, category);
    return data(copy);
  } catch (err) {
    console.error("marketing email sample generation failed; using fallback", err);
    return data(MARKETING_EMAIL_FALLBACKS[category]);
  }
}
