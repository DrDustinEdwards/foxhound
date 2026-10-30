import type { Block } from "capsomer/email";

// The win-back email copy, ported from legacy's WIN_BACK_TEMPLATES in
// app/api/cron/process-winback/route.ts (blob `18f20de9`, lines 71 to 97).
// Pure: no env, no database, no clock.
//
// THIS IS CUSTOMER-FACING MAIL SENT ON THE MERCHANT'S BEHALF, so it goes out on
// the CUSTOMER audience and carries the CAN-SPAM footer, the unsubscribe
// headers and the suppression gate, exactly as the expiring-card alert does and
// exactly opposite to the two merchant notices (sessions 47 and 48).
//
// THESE ARE THE FALLBACK HALF. Legacy tries an AI draft first and falls back to
// these templates when it fails; the AI half is app/lib/recovery/
// winback-generation.ts, and app/lib/cron/winback.ts resolves which goes out.

export const WINBACK_TEMPLATE = "winback";

/** Legacy's fallbacks, verbatim: `customer_name || 'there'`,
 *  `plan_name || 'your subscription'`, `sender_name || 'Support'`. */
export const WINBACK_FALLBACKS = {
  customerName: "there",
  planName: "your subscription",
  senderName: "Support",
} as const;

export interface WinbackCopyInput {
  stepNumber: number;
  customerName: string | null;
  planName: string | null;
  senderName: string | null;
  /** The reactivation link: /p/:token in resubscribe mode. Legacy's is a
   *  Stripe billing portal session created at send time. */
  resubscribeUrl: string;
}

interface WinbackTemplate {
  subject: string;
  /** Legacy's button label for this step. */
  cta: string;
  paragraphs: string[];
  signOff: string;
}

/**
 * Legacy's three templates, keyed by step number, wording and order verbatim.
 * The labels are legacy's; the button itself is Capsomer's, in Foxhound's amber,
 * because legacy's `CTA_BUTTON_STYLE` is its own inline style.
 */
const WINBACK_TEMPLATES: Record<number, WinbackTemplate> = {
  1: {
    subject: "We're sorry to see you go. Here's what you're missing.",
    cta: "Reactivate My Account",
    paragraphs: [
      "We noticed you recently canceled your {{plan_name}} subscription. We're sorry to see you go.",
      "If there's anything we could have done better, we'd love to hear from you. And if you ever want to come back, we'll be here.",
    ],
    signOff: "Thanks for being a customer,",
  },
  2: {
    subject: "A quick update since you left",
    cta: "Come Back",
    paragraphs: [
      "It's been a few days since you canceled, and we wanted to share what's new.",
      "We've been working hard on improvements and would love to have you back. Your account can be reactivated instantly.",
    ],
    signOff: "Thanks,",
  },
  3: {
    subject: "Last chance to reactivate your account",
    cta: "Reactivate Now",
    paragraphs: [
      "This is our last check-in. If you've decided to move on, we completely understand and wish you the best.",
      "But if you've been on the fence, now's a great time to come back. Your data is still here waiting for you.",
    ],
    signOff: "Thanks for giving us a shot,",
  },
};

/** Legacy's `WIN_BACK_TEMPLATES[step.step_number] || WIN_BACK_TEMPLATES[1]`. */
function templateFor(stepNumber: number): WinbackTemplate {
  return WINBACK_TEMPLATES[stepNumber] ?? WINBACK_TEMPLATES[1];
}

/** Legacy's subject for this step, after `applyTemplate`. Steps 2 and 3 carry
 *  no placeholders, and step 1 carries none either; the substitution runs on
 *  all three anyway, as legacy runs it. */
export function winbackSubject(input: { stepNumber: number; planName: string | null }): string {
  return applyWinbackTemplate(templateFor(input.stepNumber).subject, {
    plan_name: input.planName || WINBACK_FALLBACKS.planName,
  });
}

/** Legacy's `applyTemplate`: replace every `{{key}}` with its value. */
function applyWinbackTemplate(source: string, vars: Record<string, string>): string {
  return source.replace(/\{\{(\w+)\}\}/g, (whole, key: string) =>
    key in vars ? vars[key] : whole,
  );
}

/**
 * Legacy's body for this step, verbatim in wording and order, as Capsomer's
 * email blocks (J91, rows E13 to E15). The send seam renders them on Capsomer's
 * email component, which writes the HTML part and the plain-text part from the
 * same blocks and escapes every value, so a customer name from Stripe is shown
 * exactly as written and never read as markup. (Written as HTML before J91, a
 * name such as "Ann <Admin>" lost "<Admin>" on the way through the reader.)
 *
 * WHAT CAPSOMER'S BLOCKS CANNOT YET CARRY, kept as words: legacy's
 * "{signOff}<br>{sender_name}" line break. A paragraph has no line break,
 * so the sign-off is two paragraphs, same words.
 *
 * THE BUTTON'S TARGET is Foxhound's /p/:token resubscribe page, which opens
 * Stripe Checkout, rather than a billing portal session (APPROVED-DIFFERENCES,
 * "yes", 2026-09-19). Pure.
 */
export function buildWinbackEmail(input: WinbackCopyInput): Block[] {
  const template = templateFor(input.stepNumber);
  const vars = {
    customer_name: input.customerName || WINBACK_FALLBACKS.customerName,
    plan_name: input.planName || WINBACK_FALLBACKS.planName,
    sender_name: input.senderName || WINBACK_FALLBACKS.senderName,
  };
  return [
    { type: "paragraph", text: `Hi ${vars.customer_name},` },
    ...template.paragraphs.map((p): Block => ({ type: "paragraph", text: applyWinbackTemplate(p, vars) })),
    { type: "button", label: template.cta, url: input.resubscribeUrl },
    { type: "paragraph", text: template.signOff },
    { type: "paragraph", text: vars.sender_name },
  ];
}
