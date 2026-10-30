import { Link } from "capsomer/react/link";

import type { TocItem } from "~/lib/blog/markdown.server";

// Ported from legacy app/(marketing)/blog/[slug]/TableOfContents.tsx (Phase
// 6 Pass 2). "inline" is a <details> that collapses on small screens;
// "sidebar" is a sticky column on large screens. Both hide entirely under
// 3 headings, matching legacy.
export function TableOfContents({
  items,
  variant,
}: {
  items: TocItem[];
  variant: "sidebar" | "inline";
}) {
  if (items.length < 3) return null;

  if (variant === "inline") {
    return (
      <details className="mb-8 rounded-lg border border-border bg-surface lg:hidden">
        <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-label font-medium text-text">
          <span>Contents</span>
          <span aria-hidden="true" className="text-text-tertiary">
            +
          </span>
        </summary>
        <nav className="border-t border-border-sub px-4 pb-3 pt-1">
          <TocList items={items} compact />
        </nav>
      </details>
    );
  }

  return (
    <aside className="hidden lg:block">
      <div className="sticky top-8">
        <div className="mb-3 font-mono text-micro uppercase tracking-[0.06em] text-text-tertiary">Contents</div>
        <nav>
          <TocList items={items} compact={false} />
        </nav>
      </div>
    </aside>
  );
}

function TocList({ items, compact }: { items: TocItem[]; compact: boolean }) {
  return (
    <ol className="m-0 flex list-none flex-col gap-1.5 p-0">
      {items.map((item) => (
        <li key={item.id} className={item.level === 3 ? "pl-4" : ""}>
          <Link
            to={`#${item.id}`}
            className={`block transition-colors hover:text-brand-text ${
              item.level === 3 ? "text-label text-text-tertiary" : "text-copy text-text-secondary"
            } ${compact ? "py-0.5" : "py-1"}`}
          >
            {item.text}
          </Link>
        </li>
      ))}
    </ol>
  );
}
