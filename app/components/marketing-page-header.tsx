// Ported from legacy components/MarketingPageHeader.tsx: the shared
// eyebrow/title/subtext block. Legacy uses it on exactly seven marketing pages
// (pricing, products, demos, docs, features, privacy, terms), verified against
// legacy source rather than its own header comment, which names Blog instead of
// Products. Blog hand-rolls the pattern in BlogHeaderIntro.tsx.
//
// Container is 1080px and left aligned; the subtext clamps at 560px inside it so
// long lines do not stretch the full width. Legacy has no bottom border and does
// not center. title is ReactNode because legacy's pricing embeds an amber accent
// span in the second half of its headline.
//
// The staggered fade-in cascade legacy runs here (0/80/160/240ms) is NOT yet
// ported; it lands in the follow-up commit for this ledger row.
export function MarketingPageHeader({
  eyebrow,
  title,
  subtext,
}: {
  eyebrow: string;
  title: React.ReactNode;
  subtext?: string;
}) {
  return (
    <div className="mx-auto max-w-[1080px] px-5 pt-16 pb-10 sm:px-8">
      <div className="mb-3 text-micro font-medium uppercase tracking-widest text-text-tertiary">
        {eyebrow}
      </div>
      <h1 className="mb-3 text-page-title font-medium tracking-tight text-text">{title}</h1>
      {subtext ? (
        <p className="mb-0 max-w-[560px] text-subhead leading-relaxed text-text-secondary">
          {subtext}
        </p>
      ) : null}
    </div>
  );
}
