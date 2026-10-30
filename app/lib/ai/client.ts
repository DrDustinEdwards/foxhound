import Anthropic from "@anthropic-ai/sdk";
import { anthropicRoute } from "@dustinedwards/site-runtime/ai-gateway";

import { getDb } from "~/db";

import { buildAiCallRow } from "./cost";

// THE ONE ANTHROPIC CLIENT FACTORY.
//
// Four call sites constructed their own client inline: the dunning generator,
// the dispute drafter, the intelligence narrative and the home page's public
// email sample. Routing them through AI Gateway means one baseURL decision, and
// a decision made in four places is a decision that will eventually be made
// four different ways.
//
// WHERE THE CALLS GO is site-runtime's anthropicRoute, the one decision every site
// shares: with AI_GATEWAY_BASE_URL set, the gateway's Anthropic endpoint with body
// logging off, "foxhound" as the log metadata and AI_GATEWAY_TOKEN as the gateway's
// token; unset, Anthropic directly with nothing added. ANTHROPIC_API_KEY stays the
// credential (sent as `x-api-key`), so no key is stored in the gateway and Foxhound
// deliberately does not use the gateway's unified billing.
//
// NO MODEL, PROMPT, TOKEN OR TEMPERATURE CHANGE. This module decides a base URL
// and headers, nothing else. Every `messages.create` argument at every call site is
// byte-identical to what it was.

// EVERY CALL IS METERED HERE. Each call site names what it is (`source`) and
// whose it is (`accountId`, null for the anonymous audit and the home page's
// sample), and every `messages.create` through the client, retries included,
// writes one ai_calls row with its tokens and cost. Metering lives in the
// factory so a new call site cannot forget it. A failed cost write is logged
// and never fails the call: the copy the merchant is waiting on matters more
// than its cost row.

/** What one call site's calls are logged as in ai_calls. */
export interface AiCallMeter {
  source: string;
  accountId: string | null;
  relatedId?: string | null;
}

/** Build the Anthropic client every call site uses. */
export function createAnthropicClient(env: Env, meter: AiCallMeter): Anthropic {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }
  const { baseURL, headers } = anthropicRoute(env, "foxhound");
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, baseURL, defaultHeaders: headers });
  const create = client.messages.create.bind(client.messages);
  client.messages.create = (async (...args: Parameters<typeof create>) => {
    const response = await create(...args);
    if ("usage" in response) await recordAiCall(env, meter, args[0].model, response.usage);
    return response;
  }) as typeof create;
  return client;
}

async function recordAiCall(
  env: Env,
  meter: AiCallMeter,
  model: string,
  usage: { input_tokens: number; output_tokens: number },
): Promise<void> {
  try {
    await buildAiCallRow(getDb(env), {
      accountId: meter.accountId,
      source: meter.source,
      model,
      promptTokens: usage.input_tokens,
      completionTokens: usage.output_tokens,
      relatedId: meter.relatedId ?? null,
      createdAt: new Date(),
    });
  } catch (err) {
    console.error(`ai_calls write failed for ${meter.source}:`, err instanceof Error ? err.message : err);
  }
}
