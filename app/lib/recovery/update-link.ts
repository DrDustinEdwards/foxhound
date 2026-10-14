import { verifyCardUpdateToken } from "~/lib/card-update/token";
import { CARD_UPDATE_PATH, ENGAGEMENT_CLICK_PATH } from "~/lib/constants";
import { verifyEngagementToken } from "~/lib/engagement/token";

// THE UPDATE-LINK CHECK. No recovery or win-back email leaves without its link,
// because a body without it loses the recovery and the billable click, and
// nothing downstream notices: the send succeeds and the step is claimed.
//
// Legacy relies on the prompt alone ("use this exact placeholder URL") and
// never reads the body back. Foxhound reads it back after generation and before
// the send, and the caller falls back to the template when the link is missing
// (RULES.md 3.15), because the template always carries it.
//
// WHAT COUNTS AS CARRYING THE LINK: the minted URL as the exact value of an
// href. Printed as text it is not counted, because a client that does not
// autolink leaves the customer nothing to press. Comparison is byte for byte:
// the URL is the base URL plus base64url tokens, so it has no character HTML
// would escape.
//
// COPY READ BACK FROM STORAGE is the one case where the exact link cannot be
// expected. A card-update token carries its issue time, so the link a backoff
// retry mints differs from the one an earlier attempt wrote into the cached
// body. Stored copy therefore also passes when one of its links verifies as a
// link minted for THIS send's target and is still live. A link for another
// step, another payment or another account, or an expired one, does not pass.

const HREF = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;

/** Every href value in a body, in order. Pure. */
export function hrefsIn(bodyHtml: string): string[] {
  const out: string[] = [];
  for (const m of bodyHtml.matchAll(HREF)) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  return out;
}

/** True when the body links the minted URL exactly. Pure. */
export function linksTo(bodyHtml: string, mintedUrl: string): boolean {
  if (!mintedUrl) return false;
  return hrefsIn(bodyHtml).includes(mintedUrl);
}

/** What a dunning send's link must open: this step's click record, wrapping
 *  this payment's card-update page, on this account. */
export interface RecoveryLinkTarget {
  baseUrl: string;
  mintedUrl: string;
  stepId: string;
  accountId: string;
  failedPaymentId: string;
}

/** The token after `${baseUrl}${path}/`, or null for any other URL. */
function tokenAfter(url: string, baseUrl: string, path: string): string | null {
  const prefix = `${baseUrl}${path}/`;
  if (!url.startsWith(prefix)) return null;
  const token = url.slice(prefix.length);
  return token.length > 0 && !token.includes("/") ? token : null;
}

/**
 * True when stored dunning copy carries a working update link for this send:
 * the exact minted URL, or a click link an earlier attempt minted for the same
 * step whose card-update link still opens the same payment's page.
 */
export async function storedCopyCarriesRecoveryLink(
  env: Env,
  bodyHtml: string,
  target: RecoveryLinkTarget,
): Promise<boolean> {
  if (linksTo(bodyHtml, target.mintedUrl)) return true;
  for (const href of hrefsIn(bodyHtml)) {
    const clickToken = tokenAfter(href, target.baseUrl, ENGAGEMENT_CLICK_PATH);
    if (!clickToken) continue;
    const click = await verifyEngagementToken(env, clickToken);
    if (
      !click ||
      click.kind !== "click" ||
      click.stepId !== target.stepId ||
      click.accountId !== target.accountId ||
      !click.url
    ) {
      continue;
    }
    const cardToken = tokenAfter(click.url, target.baseUrl, CARD_UPDATE_PATH);
    if (!cardToken) continue;
    const card = await verifyCardUpdateToken(env, cardToken);
    if (
      card &&
      card.failedPaymentId === target.failedPaymentId &&
      card.accountId === target.accountId
    ) {
      return true;
    }
  }
  return false;
}

/** What a win-back send's link must open: this sequence's resubscribe page for
 *  this step, on this account. */
export interface ResubscribeLinkTarget {
  baseUrl: string;
  mintedUrl: string;
  sequenceId: string;
  stepNumber: number;
  accountId: string;
}

/**
 * True when stored win-back copy carries a working resubscribe link for this
 * send: the exact minted URL, or a /p/ link an earlier tick minted for the same
 * sequence and step that is still live.
 */
export async function storedCopyCarriesResubscribeLink(
  env: Env,
  bodyHtml: string,
  target: ResubscribeLinkTarget,
): Promise<boolean> {
  if (linksTo(bodyHtml, target.mintedUrl)) return true;
  for (const href of hrefsIn(bodyHtml)) {
    const cardToken = tokenAfter(href, target.baseUrl, CARD_UPDATE_PATH);
    if (!cardToken) continue;
    const card = await verifyCardUpdateToken(env, cardToken);
    if (
      card &&
      card.winBackSequenceId === target.sequenceId &&
      card.winBackStepNumber === target.stepNumber &&
      card.accountId === target.accountId
    ) {
      return true;
    }
  }
  return false;
}
