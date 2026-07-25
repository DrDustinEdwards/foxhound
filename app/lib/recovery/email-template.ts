import type { DeclineCategory } from "~/lib/constants";
import type { EmailCopy } from "./email-generation";

// Deterministic dunning copy: the safe output when generation cannot be used.
//
// This did not exist before. `EmailJob.template` was only ever a LABEL string
// written to `email_sends.template` for logging; there was no template CONTENT
// anywhere in the product, so a generation failure produced no email at all.
//
// Two callers, both in the send path:
//   1. A generation throw (model outage, unset/unfunded key, malformed output).
//   2. Generated copy that fails the brand-voice quality gate.
//
// In both cases a plain, correct email beats no email on a revenue-recovery
// product, which is the whole argument for this module existing.
//
// HARD REQUIREMENT: this copy must itself pass `passesQualityGate`. If the
// fallback could fail the gate the gate would have nowhere to fall back TO.
// test/recovery-email-template.test.ts asserts that across every decline
// category rather than on one sample.
//
// Constraints the copy obeys, all enforced by that test:
//   - no em or en dashes (the strongest AI tell, and a repo-wide rule)
//   - none of the AI_TELL_PHRASES the sanitizer strips from generated copy
//   - NO timing references at all. The generator is merely told not to leak the
//     schedule; a fixed template has no excuse to reference time, so it does not
//     mention days, hours, or "recently" in any form.
//   - the merchant's voice, never Foxhound's. Foxhound is not named.

export interface TemplateEmailInput {
  merchantName: string;
  declineCategory: DeclineCategory | string;
  /** Already formatted for display, e.g. "$49.00". */
  amountFormatted: string;
  /** The click-tracked card-update URL, used as the single call to action. */
  updateUrl: string;
}

function link(url: string, label: string): string {
  return `<a href="${url}">${label}</a>`;
}

/**
 * Per-category body copy. The category split exists for the same reason the
 * generator has `categoryGuidance`: naming the wrong cause is what makes dunning
 * mail read as spam. `revoked` is deliberately not a dunning message at all,
 * matching the generator's framing rule and the engine's revoked hard-stop: the
 * customer told their bank to stop paying, so the note offers a clean choice and
 * does not ask for money.
 */
function bodyFor(input: TemplateEmailInput): string {
  const { merchantName, amountFormatted, updateUrl } = input;
  const sign = `<p>Thanks,<br />${merchantName}</p>`;

  switch (input.declineCategory) {
    case "expired":
      return [
        `<p>Your card on file has expired, so we could not collect ${amountFormatted}.</p>`,
        `<p>Retrying will not help until the card is replaced. You can ${link(updateUrl, "add a new card")} to settle it.</p>`,
        sign,
      ].join("");

    case "fraud":
      return [
        `<p>Your bank declined our charge of ${amountFormatted} and flagged it for review. This is routine on recurring payments and does not mean anything is wrong with your account.</p>`,
        `<p>We will not keep retrying the same card, because repeated attempts make banks more likely to keep blocking it. You can approve the charge with your bank, or ${link(updateUrl, "use a different card")}.</p>`,
        sign,
      ].join("");

    case "network":
      return [
        `<p>Your payment of ${amountFormatted} did not go through because of a connection problem between us and your bank, not because of anything on your side.</p>`,
        `<p>We will keep trying. If you would rather use a different card, you can ${link(updateUrl, "do that here")}.</p>`,
        sign,
      ].join("");

    // The customer revoked authorization. Not a dunning case.
    case "revoked":
      return [
        `<p>Your bank tells us the authorization for this payment has been withdrawn, so we will not attempt any further charges. The outstanding amount is ${amountFormatted}.</p>`,
        `<p>If that was deliberate there is nothing more to do. If it was not, you can ${link(updateUrl, "add a new payment method")} to carry on.</p>`,
        sign,
      ].join("");

    // Unclassified decline: the engine will not guess a cause, so neither does
    // the copy. It states what happened and asks for the one reliable action.
    case "unknown":
      return [
        `<p>Your payment of ${amountFormatted} was declined. Your bank did not tell us why, so we cannot say whether it is worth retrying.</p>`,
        `<p>The reliable fix is to ${link(updateUrl, "update your payment method")}.</p>`,
        sign,
      ].join("");

    // soft, and any category the engine adds later. A soft decline is usually a
    // temporary hold rather than a problem with the account.
    default:
      return [
        `<p>Your payment of ${amountFormatted} did not go through. Your bank declined it, which usually means a temporary hold rather than a problem with your account.</p>`,
        `<p>We will try again automatically. If you would rather sort it now, you can ${link(updateUrl, "update your payment method")}.</p>`,
        sign,
      ].join("");
  }
}

function subjectFor(input: TemplateEmailInput): string {
  switch (input.declineCategory) {
    case "expired":
      return "Your card has expired";
    case "fraud":
      return "Your bank blocked a payment";
    case "network":
      return "We could not reach your bank";
    case "revoked":
      return "Your subscription payment was cancelled";
    default:
      return `A payment issue with ${input.merchantName}`;
  }
}

/**
 * Build the deterministic fallback email. Pure: no env, no model, no clock, so
 * the same input always yields the same copy and it can never fail the way the
 * thing it is backing up fails.
 */
export function buildTemplateEmail(input: TemplateEmailInput): EmailCopy {
  return {
    subject: subjectFor(input),
    bodyHtml: bodyFor(input),
  };
}
