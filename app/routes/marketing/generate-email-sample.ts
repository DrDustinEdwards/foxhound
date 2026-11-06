import { refuseCrossSite } from "@dustinedwards/site-runtime/origin";
import { data, redirect } from "react-router";

import { cloudflareContext } from "~/lib/cloudflare-context";
import { isWithinRateLimit } from "~/lib/http/rate-limit";
import { MARKETING_EMAIL_CATEGORIES, type MarketingEmailCategory } from "~/lib/marketing/email-sample";
import { generateMarketingEmailSample } from "~/lib/marketing/home-email-sample.server";

import type { Route } from "./+types/generate-email-sample";
import { readForm } from "~/lib/http/body";

// Live generation for the home page's email generator: unauthenticated, so
// abuse protection is mandatory. The rate limit is a dedicated bucket checked
// here in the action (not the shared top-level enforceRateLimit path).
//
// Over the limit (429) or when generation fails (503), the action answers
// { error: true } and the generator shows Recova's "Generation failed. Try again."
// (components/marketing/EmailGenerator.tsx, blob c4592a56; M3 divergence 28).
// It used to answer with a stored sample in the same shape, which the page
// then labeled as generated in real time.
const UNAVAILABLE = { error: true } as const;

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
  const refused = refuseCrossSite(request);
  if (refused) return refused;
  const { env } = context.get(cloudflareContext);
  let form: FormData;
  try {
    form = await readForm(request);
  } catch (err) {
    if (err instanceof Response) throw err;
    console.error("marketing email sample: unreadable form body", err);
    return data(UNAVAILABLE, { status: 400 });
  }
  const categoryInput = String(form.get("category") ?? "");
  const category: MarketingEmailCategory = isValidCategory(categoryInput) ? categoryInput : "soft";

  const key = request.headers.get("cf-connecting-ip") ?? "unknown";
  const withinLimit = await isWithinRateLimit(env, "marketing_email_sample", key, 10, 60_000);
  if (!withinLimit) {
    return data(UNAVAILABLE, { status: 429 });
  }

  try {
    const copy = await generateMarketingEmailSample(env, category);
    return data(copy);
  } catch (err) {
    console.error("marketing email sample generation failed", err);
    return data(UNAVAILABLE, { status: 503 });
  }
}
