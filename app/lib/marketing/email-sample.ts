import type { AiSampleResult } from "capsomer/behavior/ai-sample";

// The home page's live email generator, its shapes and its one request. No server-only imports, so the client component, its island
// and the server generation route can all import it. There is no stored fallback sample: a failed generation or an over-limit visitor
// sees "Generation failed. Try again.", never a canned email presented as live.

export type MarketingEmailCategory = "soft" | "network" | "expired" | "fraud";

export const MARKETING_EMAIL_CATEGORIES: MarketingEmailCategory[] = [
  "soft",
  "network",
  "expired",
  "fraud",
];

export interface MarketingEmailCopy {
  subject: string;
  body: string;
}

const GENERATE_ACTION = "/marketing/generate-email-sample";
const SAMPLE_UPDATE_URL = "https://billing.yoursaas.com/update";

/** Runs the generation route for the chosen decline type and words its answer as Capsomer's AI sample fields. Anything but an email
 *  (the route's { error: true }, a network failure, a non-JSON body) is a failed generation, never a stored sample. */
export async function generateEmailSample(data: FormData): Promise<AiSampleResult> {
  let result: Partial<MarketingEmailCopy>;
  try {
    const response = await fetch(GENERATE_ACTION, {
      method: "POST",
      body: new URLSearchParams({ category: String(data.get("decline-type") ?? "soft") }),
    });
    result = (await response.json()) as Partial<MarketingEmailCopy>;
  } catch {
    return { error: true };
  }
  if (typeof result.subject !== "string" || typeof result.body !== "string") return { error: true };
  return {
    fields: [
      { label: "Subject", value: result.subject },
      {
        label: "Body",
        value: result.body.replace("{{update_url}}", SAMPLE_UPDATE_URL),
        mono: true,
      },
    ],
    note: "Generated in real time by AI, for a fictional customer.",
  };
}
