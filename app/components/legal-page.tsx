import type { ReactNode } from "react";

import { DISPUTE_AUTO_SUBMIT_HOURS } from "~/lib/disputes/approval";
import { RECOVERY_SEQUENCE_DAYS } from "~/lib/marketing/decline-categories";

// Capsomer's tokens and the amber family (capbase layer), which the legal page, the link roles and
// the focus ring read. The site header loads the same file; importing it here keeps these pages
// whole under any layout.
import "~/site-header.css";

// The legal pages' frame and the one paragraph two of them share. The page itself (title, date,
// contents, numbered sections) is Capsomer's LegalDoc.

/**
 * The frame the legal pages' Capsomer LegalDoc sits in: Recova's 720px column in Capsomer's amber
 * family with Foxhound's own neutrals (.fh-cap, the pairing the site header uses). One main landmark
 * stays the layout's. The sizes Recova sets on the text are the .fh-legal rules in marketing.css.
 */
export function LegalBody({ children }: { children: ReactNode }) {
  return (
    <div className="fh-mk-article fh-legal fh-cap" data-cap-site="foxhound" data-family="amber">
      {children}
    </div>
  );
}

/**
 * Recova's one-paragraph description of the product, which both legal pages
 * carry, rewritten to what Foxhound does: silent retry first, the email
 * sequence's real length, and dispute responses that go to Stripe only on a
 * person's approval or the merchant's own opt-in auto-submit. The numbers are
 * the engine's constants (foxhound CLAUDE.md, hard rule 1).
 */
export function LegalServiceDescription() {
  return (
    <>
      Foxhound is a SaaS application that recovers failed subscription payments for businesses using
      Stripe. When a subscriber&apos;s payment fails, Foxhound detects the failure via Stripe
      webhook, classifies the decline, and, wherever the decline can be retried, attempts a silent
      retry before any customer ever sees an email. If there is no silent retry or it does not work,
      Foxhound generates a personalized recovery email and, unless the customer has revoked
      authorization, continues the sequence over {RECOVERY_SEQUENCE_DAYS} days. Foxhound also drafts
      dispute evidence. A drafted response goes to Stripe only when someone on the merchant&apos;s
      team approves it, or, if the merchant has turned on auto-submit (off by default),{" "}
      {DISPUTE_AUTO_SUBMIT_HOURS} hours before the dispute&apos;s evidence deadline. Merchants
      connect their Stripe account once via OAuth, and Foxhound runs automatically in the
      background. Foxhound does not store card numbers or access payout or bank account information.
    </>
  );
}
