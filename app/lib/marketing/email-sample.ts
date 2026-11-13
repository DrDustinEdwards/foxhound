import type { AiSampleResult } from "capsomer/behavior/ai-sample";

// The home page's live email generator, its shapes and its one request. No
// server-only imports, so the client component, its island and the server
// generation route can all import it.
//
// There is no stored fallback sample any more. One was shown when the model
// call failed or the visitor was over the rate limit, under a line saying it
// was generated in real time, which it was not. Recova shows "Generation
// failed. Try again." there (components/marketing/EmailGenerator.tsx, blob
// c4592a56), and so does Foxhound now (M3 divergence 28).

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

/** What the generation route answers: an email, or that it could not make one. */
export type MarketingEmailResult = MarketingEmailCopy | { error: true };

const GENERATE_ACTION = "/marketing/generate-email-sample";
const SAMPLE_UPDATE_URL = "https://billing.yoursaas.com/update";

/** Runs the generation route for the chosen decline type and words its answer as
 *  Capsomer's AI sample fields (capsomer/behavior/ai-sample). Anything but an
 *  email (the route's { error: true }, a network failure, a body that is not its
 *  JSON) is a failed generation: Recova's failure line, never a stored sample. */
export async function generateEmailSample(data: FormData): Promise<AiSampleResult> {
  const response = await fetch(GENERATE_ACTION, {
    method: "POST",
    body: new URLSearchParams({ category: String(data.get("decline-type") ?? "soft") }),
  });
  const result = (await response.json()) as Partial<MarketingEmailCopy>;
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
