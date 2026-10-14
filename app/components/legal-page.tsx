import type { ReactNode } from "react";
import { Link } from "react-router";

import "capsomer/panel.css";
// Capsomer's tokens and the teal family (capbase layer), which the Panel, the
// link roles and the focus ring read. The site header loads the same file;
// importing it here keeps these pages whole under any layout.
import "~/site-header.css";

// The legal pages' one chrome kit (J51, rows M20 and M21). Recova's privacy and
// terms pages share their wrapper, Section, H3, P, contents list, rule and link
// classes byte for byte (app/(marketing)/privacy/page.tsx and
// app/(marketing)/terms/page.tsx, read whole at blobs 8f8dfb8e and 88005fad), so
// Foxhound's two pages take them from one place too.
//
// Layout is Recova's: the 720px column with 24px sides and 64px below, the
// numbered h2 at the title size with 48px above, 16px below and an 80px scroll
// margin, the contents grid, the rule and every margin as Recova writes them.
// Look is Capsomer's (Q12): the column sits in Capsomer's teal family with
// Foxhound's own neutrals (.fh-cap, the same pairing the site header uses),
// links take Capsomer's link roles (accent text, accent hover), the focus ring
// is the family's teal ring, and the summary card is Capsomer's Panel.
// Text is on the five sizes (RULES.md 5.2): Recova's 0.9375rem body becomes
// body (1rem) and its 0.875rem summary text becomes label (0.8125rem), each the
// nearest of the five.

/** Capsomer's link, as base.css draws it, plus Recova's underline. */
export const LEGAL_LINK = "text-accent-text underline underline-offset-2 hover:text-accent-hover";

export interface LegalSectionDef {
  id: string;
  number: number;
  title: string;
}

/**
 * Recova's legal column, in Capsomer's teal family. One main landmark stays the
 * layout's. Foxhound's global focus ring reads --border-focus (app.css);
 * inside this column it reads the family's --ring instead, so a keyboard user
 * sees teal here as in Capsomer's own components.
 */
export function LegalBody({ children }: { children: ReactNode }) {
  return (
    <div className="fh-cap mx-auto max-w-[720px] px-6 pb-16 [--border-focus:var(--ring)]" data-family="teal">
      {children}
    </div>
  );
}

/** Recova's contents block: a mono micro heading over a two-column numbered list. */
export function LegalContents({ heading, sections }: { heading: string; sections: LegalSectionDef[] }) {
  return (
    <section className="mb-12">
      <h2 className="mb-3 font-mono text-micro uppercase tracking-[0.06em] text-text-tertiary">{heading}</h2>
      <ol className="m-0 grid grid-cols-1 gap-x-6 gap-y-1.5 p-0 sm:grid-cols-2">
        {sections.map((s) => (
          <li key={s.id} className="list-none text-label">
            <a href={`#${s.id}`} className={LEGAL_LINK}>
              {s.number}. {s.title}
            </a>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function LegalRule() {
  return <hr className="my-10 border-border" />;
}

const LEGAL_H2 = "mb-4 mt-12 text-title font-medium text-text";

export function LegalSection({ id, number, title, children }: LegalSectionDef & { children: ReactNode }) {
  return (
    <section>
      <h2 id={id} className={`${LEGAL_H2} scroll-mt-20`}>
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

export function LegalH3({ children }: { children: ReactNode }) {
  return <h3 className="mb-2 mt-6 text-body font-medium text-text">{children}</h3>;
}

export function LegalP({ children }: { children: ReactNode }) {
  return <p className="mb-4 text-body leading-relaxed text-text-secondary">{children}</p>;
}

export function LegalList({ children }: { children: ReactNode }) {
  return <ul className="mb-4 list-disc space-y-1.5 pl-6 text-body leading-relaxed text-text-secondary">{children}</ul>;
}

export function LegalMailto({ email }: { email: string }) {
  return (
    <a href={`mailto:${email}`} className={LEGAL_LINK}>
      {email}
    </a>
  );
}

export function LegalLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className={LEGAL_LINK}>
      {children}
    </Link>
  );
}
