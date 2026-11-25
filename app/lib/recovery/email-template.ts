import { escapeHtml } from "@dustinedwards/site-runtime/html";

import type { EmailCopy } from "./email-generation";

// Deterministic dunning copy: the safe output when generation cannot be used. HARD REQUIREMENT: this copy must itself pass `passesQualityGate`.

export interface TemplateEmailInput {
  merchantName: string;
  /** A DeclineCategory (~/lib/constants), or whatever category a stored row holds. */
  declineCategory: string;
  /** Already formatted for display, e.g. "$49.00". */
  amountFormatted: string;
  /** The click-tracked card-update URL, used as the single call to action. */
  updateUrl: string;
  /** The recovery step being sent. */
  stepType?: string;
  /** failed_payments.customer_name, raw. */
  customerName?: string | null;
  /** The merchant's sender_name, raw. */
  senderName?: string | null;
}

// Names are escaped, so a customer called "<b>" is text. Each of these passes the quality gate: no
// dash, no AI tell, no schedule leak.

interface StepTemplateVars {
  customerName: string;
  amount: string;
  senderName: string;
  updateUrl: string;
}

const button = (url: string): string => `<p><a href="${url}">Update Payment Method</a></p>`;

const STEP_TEMPLATES: Record<string, { subject: string; body: (v: StepTemplateVars) => string }> = {
  email_day1: {
    subject: "Your payment didn't go through",
    body: (v) =>
      [
        `<p>Hi ${v.customerName},</p>`,
        `<p>Your recent payment of ${v.amount} didn't process. This usually happens with an expired card or a temporary bank issue.</p>`,
        `<p>You can update your payment method here:</p>`,
        button(v.updateUrl),
        `<p>${v.senderName}</p>`,
      ].join("\n"),
  },
  email_day3: {
    subject: "Still having trouble with your payment",
    body: (v) =>
      [
        `<p>Hi ${v.customerName},</p>`,
        `<p>We still haven't been able to process your payment of ${v.amount}. Your account may be suspended if this isn't resolved.</p>`,
        button(v.updateUrl),
        `<p>${v.senderName}</p>`,
      ].join("\n"),
  },
  email_day7: {
    subject: "Account access at risk",
    body: (v) =>
      [
        `<p>Hi ${v.customerName},</p>`,
        `<p>It has been a week since your payment of ${v.amount} failed. Update your payment method now to keep your access.</p>`,
        button(v.updateUrl),
        `<p>${v.senderName}</p>`,
      ].join("\n"),
  },
  email_day14: {
    subject: "Two weeks since your payment failed",
    body: (v) =>
      [
        `<p>Hi ${v.customerName},</p>`,
        `<p>It has been two weeks since your payment of ${v.amount} did not go through. Updating your payment method only takes a minute.</p>`,
        button(v.updateUrl),
        `<p>${v.senderName}</p>`,
      ].join("\n"),
  },
  // Day 14 does not claim the update restores the account: finalizeCardUpdateSession only saves the new card as the default and charges nothing.
  email_day30: {
    subject: "Final notice on your account",
    body: (v) =>
      [
        `<p>Hi ${v.customerName},</p>`,
        `<p>This is the final automated notice on your unpaid balance of ${v.amount}. Without an updated payment method, your account may be canceled.</p>`,
        button(v.updateUrl),
        `<p>${v.senderName}</p>`,
      ].join("\n"),
  },
};

function orFallback(value: string | null | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

function hasStepTemplate(stepType: string | null | undefined): boolean {
  return stepType != null && Object.hasOwn(STEP_TEMPLATES, stepType);
}

function link(url: string, label: string): string {
  return `<a href="${url}">${label}</a>`;
}

/**
 * Per-category body copy. `revoked` is deliberately not a dunning message at all, matching the
 * generator's framing rule and the engine's revoked hard-stop: the customer told their bank to stop
 * paying, so the note offers a clean choice and does not ask for money.
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
      return "Your subscription payment was canceled";
    default:
      return `A payment issue with ${input.merchantName}`;
  }
}

/**
 * Build the deterministic fallback email. Pure: no env, no model, no clock, so the same input
 * always yields the same copy and it can never fail the way the thing it is backing up fails.
 */
export function buildTemplateEmail(input: TemplateEmailInput): EmailCopy {
  if (hasStepTemplate(input.stepType)) {
    const template = STEP_TEMPLATES[input.stepType as string];
    return {
      subject: template.subject,
      bodyHtml: template.body({
        customerName: escapeHtml(orFallback(input.customerName, "there")),
        amount: escapeHtml(input.amountFormatted),
        senderName: escapeHtml(orFallback(input.senderName, "Support")),
        updateUrl: input.updateUrl,
      }),
    };
  }
  return {
    subject: subjectFor(input),
    bodyHtml: bodyFor({
      ...input,
      merchantName: escapeHtml(input.merchantName),
      amountFormatted: escapeHtml(input.amountFormatted),
    }),
  };
}
