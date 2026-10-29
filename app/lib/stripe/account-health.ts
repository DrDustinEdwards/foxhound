import type Stripe from "stripe";

import type { EmailNotice } from "~/lib/email/templates";

// THE CONNECTED STRIPE ACCOUNT'S OWN HEALTH, read from account.updated. Stripe
// sends that event to the Connect endpoint for the connected account itself
// (event.account is its id, data.object the Account), whenever its capabilities
// or verification requirements move. Pure: the webhook handler stores what this
// reads and the sender in account-health.server.ts mails what it words.
//
// WHY IT MATTERS TO FOXHOUND. With charges disabled, every retry Foxhound makes
// on that account fails at Stripe, so the recovery tick holds retry steps
// (recovery-tick.ts) and the merchant is told. Payouts disabled and past-due
// requirements do not stop a retry, but the money a retry recovers or a won
// dispute returns sits in Stripe until the merchant acts, and past-due
// requirements are how Stripe warns that charges are next.

export interface AccountHealth {
  chargesEnabled: boolean | null;
  payoutsEnabled: boolean | null;
  disabledReason: string | null;
  pastDueCount: number | null;
  currentDeadline: Date | null;
}

/** The stored fields from one Stripe Account object. A field Stripe left out
 *  stays null, which reads as "not told", never as a problem. */
export function readAccountHealth(account: Stripe.Account): AccountHealth {
  const requirements = account.requirements ?? null;
  const deadline = requirements?.current_deadline ?? null;
  return {
    chargesEnabled: typeof account.charges_enabled === "boolean" ? account.charges_enabled : null,
    payoutsEnabled: typeof account.payouts_enabled === "boolean" ? account.payouts_enabled : null,
    disabledReason: requirements?.disabled_reason ?? null,
    pastDueCount: requirements?.past_due ? requirements.past_due.length : null,
    currentDeadline: deadline ? new Date(deadline * 1000) : null,
  };
}

export type HealthProblem = "charges_disabled" | "payouts_disabled" | "past_due";

/**
 * The problems that are NEW in `next` compared with what was stored. A problem
 * already stored is not new, so a merchant is told once when charges turn off,
 * not on every account.updated Stripe sends while they stay off. Null before
 * (never told) counts as healthy. Pure.
 */
export function newHealthProblems(prev: AccountHealth, next: AccountHealth): HealthProblem[] {
  const problems: HealthProblem[] = [];
  if (next.chargesEnabled === false && prev.chargesEnabled !== false) problems.push("charges_disabled");
  if (next.payoutsEnabled === false && prev.payoutsEnabled !== false) problems.push("payouts_disabled");
  if ((next.pastDueCount ?? 0) > 0 && (prev.pastDueCount ?? 0) === 0) problems.push("past_due");
  return problems;
}

/** Every problem the stored state shows right now, for the settings warning. Pure. */
export function currentHealthProblems(health: AccountHealth): HealthProblem[] {
  return newHealthProblems(
    { chargesEnabled: null, payoutsEnabled: null, disabledReason: null, pastDueCount: null, currentDeadline: null },
    health,
  );
}

/** Where the merchant fixes it. A Standard account signs in to its own dashboard,
 *  which shows Stripe's own banner for whatever it needs. */
export const STRIPE_DASHBOARD_URL = "https://dashboard.stripe.com/";

function formatDeadline(at: Date): string {
  return at.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** One sentence per problem, each stating only what the event said. Pure. */
export function healthProblemLines(problems: HealthProblem[], health: AccountHealth): string[] {
  const lines: string[] = [];
  if (problems.includes("charges_disabled")) {
    lines.push(
      "Stripe has turned off charges on this account. Until they are back on, every payment retry Foxhound makes " +
        "will fail, so Foxhound is holding retries and will resume them once Stripe turns charges back on.",
    );
  }
  if (problems.includes("payouts_disabled")) {
    lines.push("Stripe has turned off payouts on this account, so money it collects stays in Stripe until they are back on.");
  }
  if (problems.includes("past_due")) {
    const count = health.pastDueCount ?? 0;
    lines.push(
      `Stripe lists ${count} past-due ${count === 1 ? "requirement" : "requirements"} on this account. ` +
        "Stripe can turn off charges or payouts until they are provided.",
    );
  }
  if (health.currentDeadline) {
    lines.push(`Stripe's current deadline for this account is ${formatDeadline(health.currentDeadline)}.`);
  }
  return lines;
}

export const ACCOUNT_HEALTH_FROM_NAME = "Foxhound";

/** The merchant notice for the problems that just appeared. Pure. */
export function accountHealthNotice(
  problems: HealthProblem[],
  health: AccountHealth,
  accountLabel: string,
): { subject: string; notice: EmailNotice } {
  const subject = problems.includes("charges_disabled")
    ? `Action needed: Stripe turned off charges on ${accountLabel}`
    : `Action needed: your Stripe account ${accountLabel} needs attention`;
  return {
    subject,
    notice: {
      title: "Your Stripe account needs attention.",
      body: [...healthProblemLines(problems, health), "Sign in to your Stripe dashboard to see what Stripe needs."],
      action: { label: "Open Stripe dashboard", url: STRIPE_DASHBOARD_URL },
    },
  };
}

/** The same notice as one Slack line. Pure. */
export function accountHealthSlackText(problems: HealthProblem[], health: AccountHealth, accountLabel: string): string {
  return (
    `⚠️ *Stripe account needs attention: ${accountLabel}*\n` +
    `${healthProblemLines(problems, health).join(" ")}\n${STRIPE_DASHBOARD_URL}`
  );
}
