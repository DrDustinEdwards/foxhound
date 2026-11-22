// Click integrity guard (pure). A click sets recovery_steps.clicked_at, which becomes the billable
// "email_engaged" attribution (20% of recovered money), so a fetch of the click URL by anything that is not
// a person is a fabricated billable event. robots.txt is advisory only; user-triggered fetchers
// (ChatGPT-User, Claude-User, Perplexity-User) do not treat it as binding. This module enforces: a
// user-agent and request-shape test with no challenge page or fingerprinting, so a real customer's
// redirect is byte-identical whether it fires or not.

/**
 * User agents that must never write an engagement signal, as lowercase substrings of the UA string.
 * Named agents catch honest fetchers; the generic tokens catch scripts and scanners (none appears in
 * Chrome, Firefox, Safari or Edge UAs). Deliberately not derived from robots.txt's allowed bots: that is
 * a marketing question, this is a billing one, and they must stay free to diverge (a plant asserts this
 * list is a superset).
 */
export const AUTOMATED_AGENT_TOKENS: readonly string[] = [
  "gptbot",
  "chatgpt-user",
  "oai-searchbot",
  "claudebot",
  "claude-user",
  "claude-searchbot",
  "anthropic-ai",
  "perplexitybot",
  "perplexity-user",
  "google-extended",
  "googlebot",
  "bingbot",
  "ccbot",
  "bytespider",
  "applebot",
  "duckduckbot",
  "bot",
  "crawler",
  "spider",
  "headlesschrome",
  "curl/",
  "wget/",
  "python-requests",
  "node-fetch",
  "go-http-client",
  "okhttp",
  "libwww-perl",
];

/** Headers sent when fetching speculatively rather than because a person asked. */
const PREFETCH_HEADERS: readonly [string, string][] = [
  ["sec-purpose", "prefetch"],
  ["purpose", "prefetch"],
  ["x-moz", "prefetch"],
  ["x-purpose", "preview"],
];

/** Why a request was refused the write: a discriminated reason, so a merchant asking why an engagement is missing gets an answer. */
type AutomatedReason = "bot_user_agent" | "prefetch" | "no_user_agent" | "not_a_get";

export type EngagementSource = { automated: false } | { automated: true; reason: AutomatedReason };

/**
 * Decide whether a request may write an engagement signal. HEAD is not a click (previews and scanners
 * issue it constantly). A missing user agent is asymmetric: for a click it fails closed, because a false
 * click bills a merchant for a recovery Foxhound did not cause while a missed click only loses a bill; for
 * an open (Intelligence only, never billed, fetched by image proxies) it does not. Bot-token and prefetch
 * checks apply to both.
 */
export function classifyEngagementRequest(
  request: Request,
  kind: "click" | "open",
): EngagementSource {
  if (request.method !== "GET") return { automated: true, reason: "not_a_get" };

  for (const [header, value] of PREFETCH_HEADERS) {
    const present = request.headers.get(header);
    if (present && present.toLowerCase().includes(value)) {
      return { automated: true, reason: "prefetch" };
    }
  }

  const ua = request.headers.get("user-agent");
  if (!ua || !ua.trim()) {
    return kind === "click" ? { automated: true, reason: "no_user_agent" } : { automated: false };
  }
  if (isAutomatedUserAgent(ua)) return { automated: true, reason: "bot_user_agent" };

  return { automated: false };
}

/** Substring match on the lowercased UA; one function shared by call sites and plants. */
export function isAutomatedUserAgent(userAgent: string): boolean {
  const ua = userAgent.toLowerCase();
  return AUTOMATED_AGENT_TOKENS.some((token) => ua.includes(token));
}

/** What a recorder reports back. A skip is data, not an error: the redirect still happens. */
export type EngagementRecordResult =
  | { recorded: true }
  | { recorded: false; reason: AutomatedReason | "unknown_step" };
