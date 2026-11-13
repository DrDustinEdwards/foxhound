import { SectionTrail } from "~/components/section-trail";

// Ported from legacy components/MarketingPageHeader.tsx: the shared
// eyebrow/title/subtext block. Legacy uses it on exactly seven marketing pages
// (pricing, products, demos, docs, features, privacy, terms), verified against
// legacy source rather than its own header comment, which names Blog instead of
// Products. Blog hand-rolls the pattern in BlogHeaderIntro.tsx.
//
// Container is 1080px and left aligned; the subtext clamps at 560px inside it so
// long lines do not stretch the full width. Legacy has no bottom border and does
// not center. title is ReactNode because legacy's pricing embeds an accent span (amber here)
// span in the second half of its headline.
//
// The three lines reveal one after another as a Capsomer reveal stack (capsomer/reveal.css, CSS only).
export function MarketingPageHeader({
  eyebrow,
  title,
  subtext,
  trail,
}: {
  eyebrow: string;
  title: React.ReactNode;
  subtext?: string;
  /** A page inside a section shows its trail above the eyebrow (SectionTrail). */
  trail?: { label: string; href?: string }[];
}) {
  return (
    <div className="mx-auto max-w-[1080px] px-5 pt-16 pb-10 sm:px-8">
      {trail ? <SectionTrail items={trail} className="mb-6" /> : null}
      <div className="cap-reveal-stack">
        <div className="mb-3 fh-tiny fh-medium fh-quiet fh-caps-wide">{eyebrow}</div>
        <h1 className="mb-3 fh-page-title fh-medium tracking-tight fh-text">{title}</h1>
        {subtext ? (
          <p className="mb-0 max-w-[560px] fh-subhead fh-relaxed fh-soft">{subtext}</p>
        ) : null}
      </div>
    </div>
  );
}
