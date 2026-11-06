import { askStructured, REWRITE } from "~/lib/ai/client";
import { PLAIN_WRITING_PROMPT, retryStockPhrasing } from "~/lib/ai/plain-writing";
import { MODEL_MARKETING_EMAIL_SAMPLE } from "~/lib/constants";
import { sanitizeCopy } from "~/lib/recovery/email-generation";

import type { MarketingEmailCategory, MarketingEmailCopy } from "./email-sample";

// Live generation seam for the home page's public email generator
// (TASK-foxhound-demo-entry-parity.md item 3, reversing the earlier call to
// make it a static rotator). This is a public, unauthenticated page: the
// scenario below is a fixed fictional customer/plan per category, not a real
// merchant's brand voice, unlike generateDunningEmail in
// app/lib/recovery/email-generation.ts (which this reuses sanitizeCopy from,
// the same em-dash/AI-tell stripping every generated customer-facing email
// gets). Throws if ANTHROPIC_API_KEY is unset or the call fails. There is no static
// fallback: the route answers { error: true } and the page shows Recova's
// "Generation failed. Try again." line.

interface CategoryScenario {
  reason: string;
  customer: string;
  plan: string;
  price: string;
}

const CATEGORY_SCENARIOS: Record<MarketingEmailCategory, CategoryScenario> = {
  soft: { reason: "insufficient funds", customer: "Jordan", plan: "Growth", price: "$149/month" },
  network: {
    reason: "a processing error from the card network",
    customer: "Priya",
    plan: "Starter",
    price: "$49/month",
  },
  expired: { reason: "an expired credit card", customer: "Sam", plan: "Pro", price: "$89/month" },
  fraud: {
    reason: "a fraud flag from the customer's bank",
    customer: "Morgan",
    plan: "Business",
    price: "$299/month",
  },
};

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    subject: { type: "string" },
    body: { type: "string" },
  },
  required: ["subject", "body"],
} as const;

function buildPrompt(category: MarketingEmailCategory): string {
  const s = CATEGORY_SCENARIOS[category];
  return [
    "You are writing a payment recovery email for a fictional SaaS company,",
    "the kind a real company sends when a subscription payment fails.",
    "",
    `Customer name: ${s.customer}`,
    `Their plan: ${s.plan} at ${s.price}`,
    `Failure reason: ${s.reason}`,
    "Include the link placeholder {{update_url}} on its own line, where the",
    "customer would click to update their card.",
    "Invent a fictional company name, not Acme or Example, something that",
    "sounds like a real SaaS startup.",
    "",
    "Rules:",
    "- Write like a real person at a small software company, not corporate copy.",
    "- No performative empathy, no apology",
    "  for the payment failing.",
    "- Do not repeat the same idea three different ways.",
    "- Subject: short and specific, no clickbait.",
    "- Body: one or two short paragraphs, under 120 words, signed off with a",
    "  first name or team name.",
    "",
    PLAIN_WRITING_PROMPT,
  ].join("\n");
}

export async function generateMarketingEmailSample(
  env: Env,
  category: MarketingEmailCategory,
): Promise<MarketingEmailCopy> {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }
  const call = (instruction = ""): Promise<MarketingEmailCopy> => draftSample(env, category, instruction);
  // One retry when the sample reads as machine-written (ai/plain-writing.ts):
  // it is the email a visitor judges Foxhound by.
  return retryStockPhrasing(await call(), (copy) => `${copy.subject}\n\n${copy.body}`, call);
}

async function draftSample(env: Env, category: MarketingEmailCategory, instruction: string): Promise<MarketingEmailCopy> {
  const result = await askStructured<{ subject: string; body: string }>(
    env,
    { source: "marketing_email_sample", accountId: null },
    {
      model: MODEL_MARKETING_EMAIL_SAMPLE,
      max_tokens: 400,
      thinking: { type: "disabled" },
      // No effort: Haiku 4.5 rejects it with a 400 ("This model does not support
      // the effort parameter"), which failed every home page generation.
      messages: [{ role: "user", content: buildPrompt(category) + instruction }],
    },
    OUTPUT_SCHEMA,
    instruction ? REWRITE : {},
  );
  if (!result.ok) throw new Error(`marketing email sample generation failed: ${result.kind}`);
  return {
    subject: sanitizeCopy(String(result.value.subject ?? "")),
    body: sanitizeCopy(String(result.value.body ?? "")),
  };
}
