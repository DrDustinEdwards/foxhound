// Pre-written dunning copy for the seeded demo sequences, so the "Preview latest email" disclosure has a body to show.

import type { DeclineCategory } from "~/lib/constants";
import { formatMoney } from "@dustinedwards/site-runtime/money";
import { SITE_ORIGIN } from "~/lib/seo/jsonld";

/**
 * Where the demo's card-update links point. An unknown token renders the hosted
 * page's clean "Link not found" state, so a visitor who clicks one in the demo
 * lands somewhere coherent rather than on an error.
 */
const DEMO_CARD_UPDATE_URL = `${SITE_ORIGIN}/p/demo`;

export interface DemoEmailContext {
  customerName: string | null;
  amountCents: number;
  currency: string;
  planName: string | null;
  merchantName: string;
}

export interface DemoEmailCopy {
  subject: string;
  bodyHtml: string;
}

function greeting(customerName: string | null): string {
  if (!customerName) return "Hello";
  const first = customerName.trim().split(/\s+/)[0];
  return first ? `Hi ${first}` : "Hello";
}

function planPhrase(planName: string | null): string {
  return planName ? `your ${planName} subscription` : "your subscription";
}

function updateLink(label: string): string {
  return `<a href="${DEMO_CARD_UPDATE_URL}">${label}</a>`;
}

/**
 * The message arc per decline category. Each entry is keyed by the step type in
 * that category's schedule (app/lib/recovery/schedule.ts RECOVERY_SCHEDULES),
 * so the copy escalates the way the cadence does: an early note that assumes a
 * bank hiccup, a middle reminder that asks for an action, and a last send that
 * states the consequence plainly.
 */
type StepCopyBuilder = (ctx: DemoEmailContext) => DemoEmailCopy;

/** Wraps a step's body paragraphs in the greeting and sign-off every demo email shares. */
const mail =
  (build: (c: DemoEmailContext) => { subject: string; body: string }): StepCopyBuilder =>
  (c) => {
    const { subject, body } = build(c);
    return {
      subject,
      bodyHtml: `<p>${greeting(c.customerName)},</p>${body}<p>Thanks,<br />${c.merchantName}</p>`,
    };
  };

const SOFT: Record<string, StepCopyBuilder> = {
  email_day1: mail((c) => ({
    subject: `A payment issue on ${planPhrase(c.planName)}`,
    body: `<p>Your most recent payment of <strong>${formatMoney(c.amountCents, c.currency)}</strong> did not go through. Your bank declined it, which usually means a temporary hold rather than anything wrong with your account.</p><p>We will try again automatically over the next few days. If you would rather sort it now, you can ${updateLink("update your payment method")}.</p>`,
  })),
  email_day3: mail((c) => ({
    subject: `Still cannot process your payment`,
    body: `<p>We have tried your card a couple of times and it is still being declined. Nothing has changed on your account yet, and ${planPhrase(c.planName)} is still active.</p><p>The quickest fix is to ${updateLink("add a working payment method")}. It takes about a minute.</p>`,
  })),
  email_day7: mail((c) => ({
    subject: `Your account needs a payment method`,
    body: `<p>A week on, the <strong>${formatMoney(c.amountCents, c.currency)}</strong> payment for ${planPhrase(c.planName)} still has not cleared. Most of the time this is a card the bank has flagged, and a different card clears immediately.</p><p>${updateLink("Update your payment details")} and we will pick things up from there.</p>`,
  })),
  email_day14: mail((c) => ({
    subject: `Action needed on ${planPhrase(c.planName)}`,
    body: `<p>We have not been able to collect <strong>${formatMoney(c.amountCents, c.currency)}</strong> for two weeks. We would rather not interrupt your access, so this is a nudge before anything changes.</p><p>${updateLink("Add a payment method")} to keep everything running.</p>`,
  })),
  email_day30: mail((c) => ({
    subject: `Last notice before your subscription ends`,
    body: `<p>This is the last reminder about the unpaid <strong>${formatMoney(c.amountCents, c.currency)}</strong> on ${planPhrase(c.planName)}. Without a working payment method we will close the subscription, and you will lose access to your data after the usual retention window.</p><p>If you want to keep it, ${updateLink("update your payment method")}. If you would rather stop, no action is needed and nothing further will be charged.</p>`,
  })),
};

const NETWORK: Record<string, StepCopyBuilder> = {
  email_day3: mail((c) => ({
    subject: `We could not reach your bank`,
    body: `<p>Your payment of <strong>${formatMoney(c.amountCents, c.currency)}</strong> failed because of a connection problem between us and your bank, not because of anything on your side. We have already retried twice.</p><p>We will keep retrying. If you would like to use a different card instead, you can ${updateLink("do that here")}.</p>`,
  })),
  email_day7: mail((c) => ({
    subject: `Your payment is still not clearing`,
    body: `<p>The <strong>${formatMoney(c.amountCents, c.currency)}</strong> charge for ${planPhrase(c.planName)} has not gone through after a week of retries. At this point a different card usually solves it.</p><p>${updateLink("Update your payment method")} when you get a moment.</p>`,
  })),
  email_day14: mail((c) => ({
    subject: `Action needed on ${planPhrase(c.planName)}`,
    body: `<p>We still cannot collect <strong>${formatMoney(c.amountCents, c.currency)}</strong>. Your subscription is active for now, but we cannot leave it unpaid indefinitely.</p><p>${updateLink("Add a working payment method")} to avoid an interruption.</p>`,
  })),
  email_day30: mail((c) => ({
    subject: `Last notice before your subscription ends`,
    body: `<p>After a month of failed attempts on <strong>${formatMoney(c.amountCents, c.currency)}</strong>, we are going to close ${planPhrase(c.planName)} unless we hear from you.</p><p>${updateLink("Update your payment method")} to keep your account open.</p>`,
  })),
};

const EXPIRED: Record<string, StepCopyBuilder> = {
  email_day1: mail((c) => ({
    subject: `Your card has expired`,
    body: `<p>The card on file for ${planPhrase(c.planName)} has expired, so the <strong>${formatMoney(c.amountCents, c.currency)}</strong> payment could not be collected. Retrying will not help until the card is replaced.</p><p>${updateLink("Add your new card")} and we will collect the outstanding amount straight away.</p>`,
  })),
  email_day3: mail((c) => ({
    subject: `Reminder: your card needs replacing`,
    body: `<p>Your expired card is still on file, and <strong>${formatMoney(c.amountCents, c.currency)}</strong> is still outstanding on ${planPhrase(c.planName)}.</p><p>If your card was reissued with the same number, the expiry date and security code will have changed, so it still needs updating. You can ${updateLink("do that here")}.</p>`,
  })),
  email_day7: mail((c) => ({
    subject: `Your subscription needs a current card`,
    body: `<p>A week has passed and the card on ${planPhrase(c.planName)} is still expired. Your access has not changed yet.</p><p>${updateLink("Update your card")} to settle the <strong>${formatMoney(c.amountCents, c.currency)}</strong> balance.</p>`,
  })),
  email_day14: mail((c) => ({
    subject: `Action needed on ${planPhrase(c.planName)}`,
    body: `<p>We have been unable to charge an expired card for two weeks. We would rather not close ${planPhrase(c.planName)} over something this small.</p><p>${updateLink("Add a current card")} and everything picks up where it left off.</p>`,
  })),
  email_day30: mail((c) => ({
    subject: `Last notice before your subscription ends`,
    body: `<p>The card on your account expired a month ago and <strong>${formatMoney(c.amountCents, c.currency)}</strong> is still unpaid. Unless a current card is added, we will close ${planPhrase(c.planName)}.</p><p>${updateLink("Update your card")} if you want to keep it.</p>`,
  })),
};

const FRAUD: Record<string, StepCopyBuilder> = {
  email_day1: mail((c) => ({
    subject: `Your bank blocked a payment`,
    body: `<p>Your bank declined our <strong>${formatMoney(c.amountCents, c.currency)}</strong> charge for ${planPhrase(c.planName)} and flagged it for review. This happens routinely with recurring payments and does not mean anything is wrong with your account.</p><p>We will not retry the same card, because repeated attempts make banks more likely to keep blocking it. If you approve the charge with your bank, or ${updateLink("use a different card")}, we can collect it.</p>`,
  })),
  email_day3: mail((c) => ({
    subject: `Payment still blocked by your bank`,
    body: `<p>The block on your <strong>${formatMoney(c.amountCents, c.currency)}</strong> payment is still in place. Only your bank can lift it, or you can sidestep it with another card.</p><p>${updateLink("Add a different payment method")} whenever suits you.</p>`,
  })),
  email_day7: mail((c) => ({
    subject: `Your payment needs your bank's approval`,
    body: `<p>A week on, your bank is still declining the charge for ${planPhrase(c.planName)}. A quick call to them usually clears it, and a different card works immediately.</p><p>${updateLink("Update your payment method")} if that is easier.</p>`,
  })),
  email_day14: mail((c) => ({
    subject: `Action needed on ${planPhrase(c.planName)}`,
    body: `<p>We have not been able to collect <strong>${formatMoney(c.amountCents, c.currency)}</strong> for two weeks because of the block on your card.</p><p>${updateLink("Add a payment method")} to keep your subscription active.</p>`,
  })),
  email_day30: mail((c) => ({
    subject: `Last notice before your subscription ends`,
    body: `<p>The <strong>${formatMoney(c.amountCents, c.currency)}</strong> charge on ${planPhrase(c.planName)} has been blocked for a month. Without a working payment method we will close the subscription.</p><p>${updateLink("Update your payment method")} if you want to keep it open.</p>`,
  })),
};

// One send, then the sequence stops. The customer told their bank to stop
// paying us, so the only respectful message offers a clean choice and then goes
// quiet. No cadence, no chasing.
const REVOKED: Record<string, StepCopyBuilder> = {
  email_revoked: mail((c) => ({
    subject: `Your subscription payment was canceled`,
    body: `<p>Your bank tells us the authorization for ${planPhrase(c.planName)} has been withdrawn, so we will not attempt any further charges. The outstanding amount is <strong>${formatMoney(c.amountCents, c.currency)}</strong>.</p><p>If that was deliberate, there is nothing more to do and you will not hear from us about it again. If it was not, you can ${updateLink("add a new payment method")} to carry on.</p>`,
  })),
};

// An unrecognized decline code. The engine will not guess a cause, so neither
// does the copy: it states what happened and asks for the one action that
// reliably works.
const UNKNOWN: Record<string, StepCopyBuilder> = {
  email_day1: mail((c) => ({
    subject: `A payment issue on ${planPhrase(c.planName)}`,
    body: `<p>Your <strong>${formatMoney(c.amountCents, c.currency)}</strong> payment was declined. Your bank did not tell us why, so we cannot say whether it is worth retrying.</p><p>The reliable fix is to ${updateLink("update your payment method")}.</p>`,
  })),
  email_day3: mail((c) => ({
    subject: `Your payment is still declined`,
    body: `<p>We still cannot collect <strong>${formatMoney(c.amountCents, c.currency)}</strong> for ${planPhrase(c.planName)}, and your bank has not given a reason.</p><p>${updateLink("Adding a different payment method")} is the fastest way past it.</p>`,
  })),
  email_day7: mail((c) => ({
    subject: `Your subscription needs a working payment method`,
    body: `<p>A week on, the payment for ${planPhrase(c.planName)} is still being declined without explanation. Your access has not changed.</p><p>${updateLink("Update your payment details")} when you can.</p>`,
  })),
  email_day14: mail((c) => ({
    subject: `Action needed on ${planPhrase(c.planName)}`,
    body: `<p>Two weeks of declines on <strong>${formatMoney(c.amountCents, c.currency)}</strong>, with no reason given by the bank. We would rather fix this than close your account.</p><p>${updateLink("Add a payment method")} to keep things running.</p>`,
  })),
  email_day30: mail((c) => ({
    subject: `Last notice before your subscription ends`,
    body: `<p>We have been unable to collect <strong>${formatMoney(c.amountCents, c.currency)}</strong> on ${planPhrase(c.planName)} for a month. Unless a working payment method is added, we will close the subscription.</p><p>${updateLink("Update your payment method")} if you want to keep it.</p>`,
  })),
};

const BY_CATEGORY: Record<DeclineCategory, Record<string, StepCopyBuilder>> = {
  soft: SOFT,
  network: NETWORK,
  expired: EXPIRED,
  fraud: FRAUD,
  revoked: REVOKED,
  unknown: UNKNOWN,
};

/**
 * Copy for one seeded email step, or null when the step type is not an email
 * step in that category's schedule. Returning null rather than a fallback
 * string is deliberate: a missing entry means the schedule and this file have
 * drifted, and a silent generic body would hide that.
 */
export function demoEmailCopyFor(
  category: DeclineCategory,
  stepType: string,
  ctx: DemoEmailContext,
): DemoEmailCopy | null {
  const build = BY_CATEGORY[category]?.[stepType];
  return build ? build(ctx) : null;
}

/**
 * The win-back arc, for a customer who has already canceled. Three sends,
 * warmer than dunning: there is no unpaid balance to collect, only an offer to
 * come back.
 */
const WIN_BACK: Record<number, StepCopyBuilder> = {
  1: mail((c) => ({
    subject: `Sorry to see you go`,
    body: `<p>Your ${planPhrase(c.planName)} has been canceled and your final invoice is settled, so there is nothing outstanding.</p><p>If something specific pushed you out, we would genuinely like to hear it. And if you change your mind, your account and data are still here.</p>`,
  })),
  2: mail(() => ({
    subject: `Your data is still here`,
    body: `<p>A quick note that your account has not been deleted. Everything you had is intact, and starting again takes one click rather than a fresh setup.</p><p>No pressure either way.</p>`,
  })),
  3: mail((c) => ({
    subject: `Last note from us`,
    body: `<p>This is the last message you will get from us about your canceled ${planPhrase(c.planName)}. Your data stays available for a while yet if you want to pick it back up.</p><p>Either way, thanks for having been a customer.</p>`,
  })),
};

/** Copy for a seeded win-back step, or null for an unknown step number. */
export function demoWinBackCopyFor(
  stepNumber: number,
  ctx: DemoEmailContext,
): DemoEmailCopy | null {
  const build = WIN_BACK[stepNumber];
  return build ? build(ctx) : null;
}
