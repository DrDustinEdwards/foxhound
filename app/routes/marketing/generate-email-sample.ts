import { refuseCrossSite } from "@dustinedwards/site-runtime/origin";
import { data, redirect } from "react-router";

import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import { isIpWithinRateLimit, isWithinRateLimit } from "~/lib/http/rate-limit";
import {
  MARKETING_EMAIL_CATEGORIES,
  type MarketingEmailCategory,
} from "~/lib/marketing/email-sample";
import { generateMarketingEmailSample } from "~/lib/marketing/home-email-sample.server";

import type { Route } from "./+types/generate-email-sample";
import { readForm } from "@dustinedwards/site-runtime/body";
import { BODY_MAX_BYTES } from "~/lib/http/body";

// Live generation for the home page's email generator: unauthenticated, so abuse protection is mandatory. The rate limit is a dedicated bucket checked here in the action (not the shared top-level limitPublicActions path). Over the limit (429) or when generation fails (503), the action answers { error: true } and the generator shows "Generation failed. Try again.", rather than passing a stored sample off as one generated in real time.
const UNAVAILABLE = { error: true } as const;

function isValidCategory(value: string): value is MarketingEmailCategory {
  return (MARKETING_EMAIL_CATEGORIES as string[]).includes(value);
}

// POST only. A stray GET (crawler, prefetch) has nothing to render here, so it bounces to the home page instead of erroring.
export function loader() {
  return redirect("/");
}

export async function action({ request, context }: Route.ActionArgs) {
  const refused = refuseCrossSite(request);
  if (refused) return refused;
  const { env } = context.get(cloudflareContext);
  let form: FormData;
  try {
    form = await readForm(request, BODY_MAX_BYTES);
  } catch (err) {
    if (err instanceof Response) throw err;
    console.error("marketing email sample: unreadable form body", err);
    return data(UNAVAILABLE, { status: 400 });
  }
  const categoryInput = String(form.get("category") ?? "");
  const category: MarketingEmailCategory = isValidCategory(categoryInput) ? categoryInput : "soft";

  // Every call spends the Anthropic key with no account behind it: both limits fail closed, and the all-visitors
  // bucket caps the spend when many addresses call at once.
  try {
    const allowed =
      (await isIpWithinRateLimit(
        env,
        request,
        "marketing_email_sample",
        { max: 10, windowMs: 60_000 },
        { failClosed: true },
      )) &&
      (await isWithinRateLimit(env, "marketing_email_sample_all", "all", 600, 60 * 60_000, {
        failClosed: true,
      }));
    if (!allowed) return data(UNAVAILABLE, { status: 429 });
  } catch {
    return data(UNAVAILABLE, { status: 503 });
  }

  try {
    const copy = await generateMarketingEmailSample(env, category);
    return data(copy);
  } catch (err) {
    console.error("marketing email sample generation failed", err);
    return data(UNAVAILABLE, { status: 503 });
  }
}
