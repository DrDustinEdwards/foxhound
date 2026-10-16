// THE CLICK INTEGRITY GUARD (368 ruling 1). Pure, so the decision is testable
// without a request, a database or a network.
//
// WHY THIS EXISTS, AND WHY IT IS A MONEY GUARD RATHER THAN A CRAWLER NUISANCE.
// The billable chain, traced end to end:
//
//   /e/c/:token  ->  recordClick  ->  buildClickStamp sets recovery_steps.clicked_at
//                ->  findAttributionSignals reads `clickedAt != null`
//                ->  resolveAttribution returns kind "email_engaged"
//                ->  "email_engaged" is in BILLABLE_ATTRIBUTION_KINDS
//                ->  recovered_payments.attribution_kind on invoice.payment_succeeded
//                ->  the billing run and computeFoxhoundAddsCents charge 20% of it
//
// So a fetch of the click URL by anything that is not a person is a fabricated
// billable event. PRICING rev 3's whole promise is that Foxhound earns only when
// it creates money the merchant can verify; a click nobody made is the one
// failure that promise cannot survive.
//
// ROBOTS.TXT IS THE ADVISORY HALF AND IS NOT SUFFICIENT (368 ruling 1). The
// group-parity fix in app/routes/files/robots.ts now excludes /e/ from every
// named group, and a well-behaved crawler will obey it. The agents that make
// this urgent are the USER-TRIGGERED fetchers (ChatGPT-User, Claude-User,
// Perplexity-User): a customer pastes a dunning email into an assistant, the
// assistant fetches the link on their behalf, and such fetchers do not uniformly
// treat robots.txt as binding because a human asked for the specific URL. This
// module is the enforcing half.
//
// IT MUST NOT COST A REAL CLICK. No challenge page, no JavaScript gate, no
// fingerprinting: 368's bounds and, more to the point, any of those would break
// the redirect for the customer whose payment we are trying to recover. The
// guard is a user-agent and request-shape test that runs in microseconds, and
// the redirect is byte-identical whether it fires or not.

/**
 * User agents that must never write an engagement signal, as lowercase
 * substrings matched against the full UA string.
 *
 * NAMED AGENTS FIRST, then conservative generic tokens. Both halves are needed
 * and neither is sufficient: the named list catches the fetchers that identify
 * themselves honestly and is the list 368 enumerates, while the generic tokens
 * catch the long tail of scripts and scanners that will never appear in any
 * curated list. Every generic token below was checked against the user-agent
 * strings mainstream browsers actually send: none of Chrome, Firefox, Safari or
 * Edge contains any of them.
 *
 * DELIBERATELY NOT DERIVED FROM robots.ts's ALLOWED_BOTS. That list answers "who
 * do we WANT crawling the public site", which is a marketing question and
 * includes agents we are courting. This one answers "who must not write money
 * data", which is a billing question. They overlap today and must stay free to
 * diverge; a plant asserts this list is a SUPERSET of that one, which ties them
 * without welding them together.
 */
export const AUTOMATED_AGENT_TOKENS: readonly string[] = [
  // Named, per 368 ruling 1's minimum list.
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
  // Generic. None of these appears in a mainstream browser's UA string.
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

/** Headers a client sends when it is fetching speculatively rather than because
 *  a person asked for the page. Chrome sends Sec-Purpose, older Chrome sent
 *  Purpose, Firefox sends X-Moz, Safari sends X-Purpose. */
const PREFETCH_HEADERS: readonly [string, string][] = [
  ["sec-purpose", "prefetch"],
  ["purpose", "prefetch"],
  ["x-moz", "prefetch"],
  ["x-purpose", "preview"],
];

/**
 * Why a request was refused the write. A DISCRIMINATED OUTCOME, never a bare
 * boolean (339 binding 5): "a bot", "a prefetch" and "no user agent at all" are
 * three different findings and the reason is what a later reader needs when a
 * merchant asks why an engagement is missing.
 */
export type AutomatedReason = "bot_user_agent" | "prefetch" | "no_user_agent" | "not_a_get";

export type EngagementSource =
  | { automated: false }
  | { automated: true; reason: AutomatedReason };

/**
 * Decide whether a request may write an engagement signal.
 *
 * HEAD IS NOT A CLICK. A loader runs for HEAD as well as GET, and nothing in
 * this repo checked the method before now, so a HEAD probe wrote a billable
 * signal. Link-preview generators and security scanners issue HEAD constantly.
 *
 * THE MISSING USER AGENT IS TREATED ASYMMETRICALLY, and the asymmetry is the one
 * judgement call in this module.
 *
 * For a CLICK it fails closed. A browser following a link in an email always
 * sends a UA; a script frequently does not. The two errors are not symmetric: a
 * false click bills a merchant for a recovery Foxhound did not cause, while a
 * missed click only means Foxhound does not bill for one it did. Under
 * outcome-based pricing the first is fatal to the promise and the second is a
 * loss, so the tie goes to refusing.
 *
 * For an OPEN it does not. Open feeds Intelligence and never bills (PRICING:
 * opens are inflated by Apple MPP), and it is fetched by mail clients and image
 * proxies whose UA habits are nothing like a browser's. Failing closed there
 * would quietly degrade a metric for no money benefit, which is a cost with no
 * matching risk. The bot-token and prefetch checks still apply to both.
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

/** Substring match on the lowercased UA. Exported so a plant can drive the
 *  token list directly and so the rule is one function rather than a regex
 *  copied into two call sites. */
export function isAutomatedUserAgent(userAgent: string): boolean {
  const ua = userAgent.toLowerCase();
  return AUTOMATED_AGENT_TOKENS.some((token) => ua.includes(token));
}

/** What a recorder reports back. A skip is DATA, not an error: the redirect
 *  still happens and the caller logs the reason at debug. */
export type EngagementRecordResult =
  | { recorded: true }
  | { recorded: false; reason: AutomatedReason | "unknown_step" };
