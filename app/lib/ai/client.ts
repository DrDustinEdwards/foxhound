import Anthropic from "@anthropic-ai/sdk";
import { anthropicRoute } from "@dustinedwards/site-runtime/ai-gateway";

// THE ONE ANTHROPIC CLIENT FACTORY (346, session 54).
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

/** Build the Anthropic client every call site uses. */
export function createAnthropicClient(env: Env): Anthropic {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }
  const { baseURL, headers } = anthropicRoute(env, "foxhound");
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, baseURL, defaultHeaders: headers });
}
