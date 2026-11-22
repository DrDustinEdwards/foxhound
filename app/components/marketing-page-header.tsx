import { SectionTrail } from "~/components/section-trail";

// The shared eyebrow/title/subtext block, used on pricing, products, demos, docs, features, privacy and terms; the blog hand-rolls it in BlogHeaderIntro.tsx. The container is 1080px and left aligned; the subtext clamps at 560px so long lines do not stretch the full width. title is ReactNode so pricing can embed an accent span (amber) in the second half of its headline. The three lines reveal one after another as a Capsomer reveal stack (capsomer/reveal.css, CSS only).
export function MarketingPageHeader({
  title,
  subtext,
  trail,
}: {
  title: React.ReactNode;
  subtext?: string;
  /** A page inside a section shows its trail above the title (SectionTrail). */
  trail?: { label: string; href?: string }[];
}) {
  return (
    <div className="fh-mkhead-wrap">
      {trail ? <SectionTrail items={trail} className="fh-mkhead-block" /> : null}
      <div className="cap-reveal-stack">
        <h1 className="fh-mk-heading fh-page-title fh-medium fh-text">{title}</h1>
        {subtext ? <p className="fh-mk-measure fh-subhead fh-relaxed fh-soft">{subtext}</p> : null}
      </div>
    </div>
  );
}
