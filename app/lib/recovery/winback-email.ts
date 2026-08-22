// The win-back email copy, ported from legacy's WIN_BACK_TEMPLATES in
// app/api/cron/process-winback/route.ts (blob `18f20de9`, lines 71 to 97).
// Pure: no env, no database, no clock.
//
// THIS IS CUSTOMER-FACING MAIL SENT ON THE MERCHANT'S BEHALF, so it goes out on
// the CUSTOMER audience and carries the CAN-SPAM footer, the unsubscribe
// headers and the suppression gate, exactly as the expiring-card alert does and
// exactly opposite to the two merchant notices (sessions 47 and 48).
//
// WHAT IS NOT PORTED, and it is half of legacy's generator: legacy tries an AI
// draft first (Sonnet, per-step description, brand voice, under 120 words),
// runs it through a Haiku quality gate, strips dashes and timing words, caches
// the result on the step row, and falls back to these templates only when that
// fails. The template half is what session 52 was scoped to and what ships
// here; `ai_subject` and `ai_body_html` stay unread, and a send is recorded as
// legacy's `email_sent_fallback` rather than `email_sent_ai`, which is the
// honest label for what actually went out.

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
  /** The reactivation link: /p/:token in resubscribe mode (344). Legacy's is a
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
 *
 * ONE DIFFERENCE, forced and recorded: the button is a PLAIN ANCHOR. Legacy
 * styles it from `CTA_BUTTON_STYLE`, built out of its EMAIL_COLORS module,
 * which Foxhound does not have and which check-tokens fails the build on. The
 * labels are legacy's.
 */
const WINBACK_TEMPLATES: Record<number, WinbackTemplate> = {
  1: {
    subject: "We're sorry to see you go. Here's what you're missing.",
    cta: "Reactivate My Account",
    paragraphs: [
      "We noticed you recently cancelled your {{plan_name}} subscription. We're sorry to see you go.",
      "If there's anything we could have done better, we'd love to hear from you. And if you ever want to come back, we'll be here.",
    ],
    signOff: "Thanks for being a customer,",
  },
  2: {
    subject: "A quick update since you left",
    cta: "Come Back",
    paragraphs: [
      "It's been a few days since you cancelled, and we wanted to share what's new.",
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
export function applyWinbackTemplate(source: string, vars: Record<string, string>): string {
  return source.replace(/\{\{(\w+)\}\}/g, (whole, key: string) =>
    key in vars ? vars[key] : whole,
  );
}

/** Legacy's body for this step, verbatim in wording and order. */
export function buildWinbackEmail(input: WinbackCopyInput): string {
  const template = templateFor(input.stepNumber);
  const vars = {
    customer_name: input.customerName || WINBACK_FALLBACKS.customerName,
    plan_name: input.planName || WINBACK_FALLBACKS.planName,
    sender_name: input.senderName || WINBACK_FALLBACKS.senderName,
    resubscribe_url: input.resubscribeUrl,
  };
  const body =
    `<p>Hi {{customer_name}},</p>` +
    template.paragraphs.map((p) => `<p>${p}</p>`).join("") +
    `<p><a href="{{resubscribe_url}}">${template.cta}</a></p>` +
    `<p>${template.signOff}<br>{{sender_name}}</p>`;
  return applyWinbackTemplate(body, vars);
}
