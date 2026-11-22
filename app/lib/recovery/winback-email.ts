import type { Block } from "capsomer/email";

// Pure: no env, no database, no clock. THESE ARE THE FALLBACK HALF.

export const WINBACK_TEMPLATE = "winback";

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
  /** The reactivation link: /p/:token in resubscribe mode. */
  resubscribeUrl: string;
}

interface WinbackTemplate {
  subject: string;
  cta: string;
  paragraphs: string[];
  signOff: string;
}

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

function templateFor(stepNumber: number): WinbackTemplate {
  return WINBACK_TEMPLATES[stepNumber] ?? WINBACK_TEMPLATES[1];
}

export function winbackSubject(input: { stepNumber: number; planName: string | null }): string {
  return applyWinbackTemplate(templateFor(input.stepNumber).subject, {
    plan_name: input.planName || WINBACK_FALLBACKS.planName,
  });
}

function applyWinbackTemplate(source: string, vars: Record<string, string>): string {
  return source.replace(/\{\{(\w+)\}\}/g, (whole, key: string) =>
    key in vars ? vars[key] : whole,
  );
}

/**
 * The send seam renders them on Capsomer's email component, which writes the HTML part and the
 * plain-text part from the same blocks and escapes every value, so a customer name from Stripe is
 * shown exactly as written and never read as markup. THE BUTTON'S TARGET is Foxhound's /p/:token
 * resubscribe page, which opens Stripe Checkout, rather than a billing portal session.
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
    ...template.paragraphs.map((p): Block => ({
      type: "paragraph",
      text: applyWinbackTemplate(p, vars),
    })),
    { type: "button", label: template.cta, url: input.resubscribeUrl },
    { type: "paragraph", text: template.signOff },
    { type: "paragraph", text: vars.sender_name },
  ];
}
