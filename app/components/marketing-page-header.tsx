// Ported from legacy components/MarketingPageHeader.tsx (Phase 6 Pass 1):
// the shared eyebrow/title/subtext block used at the top of /pricing,
// /products, /demos, /docs, /privacy, /terms.
export function MarketingPageHeader({
  eyebrow,
  title,
  subtext,
}: {
  eyebrow: string;
  title: string;
  subtext?: string;
}) {
  return (
    <div className="border-b border-border-sub px-4 py-16 text-center sm:px-8">
      <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">{eyebrow}</p>
      <h1 className="mt-3 text-display font-medium text-text">{title}</h1>
      {subtext ? <p className="mx-auto mt-3 max-w-xl text-body text-text-secondary">{subtext}</p> : null}
    </div>
  );
}
