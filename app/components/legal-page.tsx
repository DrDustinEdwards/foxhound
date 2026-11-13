import type { ReactNode } from "react";
import { Link } from "capsomer/react/link";

import { DISPUTE_AUTO_SUBMIT_HOURS } from "~/lib/disputes/approval";
import { RECOVERY_SEQUENCE_DAYS } from "~/lib/marketing/decline-categories";

import "capsomer/panel.css";
// Capsomer's tokens and the amber family (capbase layer), which the Panel, the
// link roles and the focus ring read. The site header loads the same file;
// importing it here keeps these pages whole under any layout.
import "~/site-header.css";

// The legal pages' one chrome kit. Recova's privacy and
// terms pages share their wrapper, Section, H3, P, contents list, rule and link
// classes byte for byte (app/(marketing)/privacy/page.tsx and
// app/(marketing)/terms/page.tsx, read whole at blobs 8f8dfb8e and 88005fad), so
// Foxhound's two pages take them from one place too.
//
// Layout is Recova's: the 720px column with 24px sides and 64px below, the
// numbered h2 at the title size with 48px above, 16px below and an 80px scroll
// margin, the contents grid, the rule and every margin as Recova writes them.
// Look is Capsomer's: the column sits in Capsomer's amber family with
// Foxhound's own neutrals (.fh-cap, the same pairing the site header uses),
// links take Capsomer's link roles (accent text, accent hover), the focus ring
// is the family's amber ring, and the summary card is Capsomer's Panel.
// Text is at Recova's sizes: the 0.9375rem body, the 1.25rem section heads and
// the 0.875rem summary.

export interface LegalSectionDef {
  id: string;
  number: number;
  title: string;
}

/**
 * Recova's legal column, in Capsomer's amber family. One main landmark stays the
 * layout's.
 */
export function LegalBody({ children }: { children: ReactNode }) {
  return (
    <div className="fh-mk-article fh-cap" data-cap-site="foxhound" data-family="amber">
      {children}
    </div>
  );
}

/** Recova's contents block: a mono micro heading over a two-column numbered list. */
export function LegalContents({
  heading,
  sections,
}: {
  heading: string;
  sections: LegalSectionDef[];
}) {
  return (
    <section className="fh-legal-band">
      <h2 className="fh-mk-kicker-gap fh-mono fh-tiny fh-quiet">{heading}</h2>
      <ol className="fh-mk-grid-2">
        {sections.map((s) => (
          <li key={s.id} className="fh-small">
            <a href={`#${s.id}`}>
              {s.number}. {s.title}
            </a>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function LegalRule() {
  return <hr className="fh-legal-block" />;
}

const LEGAL_H2 = "fh-legal-heading fh-title fh-medium fh-text";

export function LegalSection({
  id,
  number,
  title,
  children,
}: LegalSectionDef & { children: ReactNode }) {
  return (
    <section>
      <h2 id={id} className={`fh-legal-title ${LEGAL_H2}`}>
        {number}. {title}
      </h2>
      {children}
    </section>
  );
}

/** Terms' unnumbered preamble heading: Recova gives it no scroll margin, being in no contents list. */
export function LegalPreambleHeading({ children }: { children: ReactNode }) {
  return <h2 className={LEGAL_H2}>{children}</h2>;
}

export function LegalH3({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <h3 id={id} className="fh-legal-title-2 fh-item-title fh-medium fh-text">
      {children}
    </h3>
  );
}

export function LegalP({ children }: { children: ReactNode }) {
  return <p className="fh-legal-text fh-subhead fh-relaxed fh-soft">{children}</p>;
}

export function LegalList({ children }: { children: ReactNode }) {
  return <ul className="fh-legal-list fh-subhead fh-relaxed fh-soft">{children}</ul>;
}

export function LegalMailto({ email }: { email: string }) {
  return <a href={`mailto:${email}`}>{email}</a>;
}

export function LegalLink({ to, children }: { to: string; children: ReactNode }) {
  return <Link to={to}>{children}</Link>;
}

/** A link off the site, in the same tab as every public link (link-rules), marked as leaving it. */
export function LegalExternal({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} rel="external noopener noreferrer">
      {children}
    </a>
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
