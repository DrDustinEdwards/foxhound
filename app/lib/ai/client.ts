import Anthropic from "@anthropic-ai/sdk";

// THE ONE ANTHROPIC CLIENT FACTORY (346, session 54).
//
// Four call sites constructed their own client inline: the dunning generator,
// the dispute drafter, the intelligence narrative and the home page's public
// email sample. Routing them through AI Gateway means one baseURL decision, and
// a decision made in four places is a decision that will eventually be made
// four different ways.
//
// ROUTING IS OPT IN, BY ENVIRONMENT. With AI_GATEWAY_BASE_URL set, every client
// points at the gateway; unset, the SDK's own default applies and nothing
// changes. Production routes through the gateway once Dustin sets the var;
// local runs and the test suite do not, which is why the fallback is the SDK
// default rather than a hardcoded gateway URL.
//
// BRING YOUR OWN KEY. ANTHROPIC_API_KEY stays the credential and the SDK sends
// it as `x-api-key`, so there is no gateway-side billing and no key stored in
// the gateway. The 2026-08-07 unified control plane offers one credit balance
// across providers; Foxhound deliberately does not use it.
//
// NO MODEL, PROMPT, TOKEN OR TEMPERATURE CHANGE. This module decides a base URL
// and a logging header, nothing else. Every `messages.create` argument at every
// call site is byte-identical to what it was.

/**
 * BODY LOGGING IS OFF, AND IT IS OFF HERE RATHER THAN IN THE DASHBOARD.
 *
 * AI Gateway logs request and response BODIES by default
 * (developers.cloudflare.com/ai-gateway/observability/logging/). Two of the four
 * call sites put real customer data in those bodies: the dunning prompt carries
 * the customer name, the merchant's name and industry, the amount and the
 * decline category, and the dispute prompt carries the dispute's grounding
 * facts.
 *
 * `cf-aig-collect-log-payload: false` skips storing the bodies and keeps the
 * metadata log, so token counts, model, status, cost and duration still arrive,
 * which is the reason for putting a gateway there at all.
 *
 * IT IS A HEADER AND NOT A DASHBOARD TOGGLE ON PURPOSE. A dashboard setting
 * cannot be diffed, cannot be reviewed and cannot be pinned by a test, so it can
 * drift silently and nothing notices. A default header is in the tree and a
 * mutation against it goes red.
 */
export const AI_GATEWAY_NO_BODY_LOG_HEADER = "cf-aig-collect-log-payload";

/**
 * Build the Anthropic client every call site uses.
 *
 * `baseURL` is `undefined` when AI_GATEWAY_BASE_URL is unset, which is how the
 * SDK is told to use its own default; passing an empty string would point the
 * client at nothing.
 */
export function createAnthropicClient(env: Env): Anthropic {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }
  return new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    baseURL: env.AI_GATEWAY_BASE_URL || undefined,
    defaultHeaders: { [AI_GATEWAY_NO_BODY_LOG_HEADER]: "false" },
  });
}
