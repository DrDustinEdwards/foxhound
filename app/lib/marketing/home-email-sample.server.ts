import { createAnthropicClient } from "~/lib/ai/client";
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
// gets). Isolated seam: constructs its own Anthropic client per call and
// throws if ANTHROPIC_API_KEY is unset or the call fails. There is no static
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
    "- Never use em dashes or en dashes. Use commas or short sentences instead.",
    "- Write like a real person at a small software company, not corporate copy.",
    "- No \"I hope this finds you well\", no performative empathy, no apology",
    "  for the payment failing.",
    "- Do not repeat the same idea three different ways.",
    "- Subject: short and specific, no clickbait.",
    "- Body: one or two short paragraphs, under 120 words, signed off with a",
    "  first name or team name.",
  ].join("\n");
}

export async function generateMarketingEmailSample(
  env: Env,
  category: MarketingEmailCategory,
): Promise<MarketingEmailCopy> {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }
  const client = createAnthropicClient(env);

  const response = await client.messages.create({
    model: MODEL_MARKETING_EMAIL_SAMPLE,
    max_tokens: 400,
    thinking: { type: "disabled" },
    // No effort: Haiku 4.5 rejects it with a 400 ("This model does not support
    // the effort parameter"), which failed every home page generation.
    output_config: {
      format: { type: "json_schema", schema: OUTPUT_SCHEMA },
    },
    messages: [{ role: "user", content: buildPrompt(category) }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("marketing email sample generation returned no text block");
  }
  const parsed = JSON.parse(textBlock.text) as { subject: string; body: string };
  return {
    subject: sanitizeCopy(parsed.subject),
    body: sanitizeCopy(parsed.body),
  };
}
