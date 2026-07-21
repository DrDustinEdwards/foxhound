import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Link } from "react-router";

import { PRODUCT_MANIFEST, PRODUCT_ORDER, type ProductKey } from "~/lib/nav/manifest";

// The only client behavior on the desktop nav besides the theme toggle (task
// Part 2 rule 4): open/close state + click-outside. Everything it renders is
// sourced from the manifest, not props threaded down from the layout.
export function ProductSwitcher({
  activeProductKey,
  intelligenceEntitled,
}: {
  activeProductKey: ProductKey;
  intelligenceEntitled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const visibleProducts = PRODUCT_ORDER.filter((key) => key !== "intelligence" || intelligenceEntitled);
  const activeLabel = PRODUCT_MANIFEST[activeProductKey].label;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 font-mono text-label font-medium text-chrome-text hover:border-border-i"
      >
        {activeLabel}
        <ChevronDown
          width={10}
          height={6}
          strokeWidth={1.5}
          aria-hidden
          className={`shrink-0 text-chrome-text-secondary transition-transform duration-150 ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open ? (
        <div className="absolute top-full left-0 z-50 mt-1 min-w-[180px] rounded-md border border-border bg-surface py-1 shadow-lg">
          {visibleProducts.map((key) => {
            const product = PRODUCT_MANIFEST[key];
            const isActive = key === activeProductKey;
            return (
              <Link
                key={key}
                to={product.href}
                onClick={() => setOpen(false)}
                aria-current={isActive ? "page" : undefined}
                className={`block px-3 py-2 text-label no-underline hover:opacity-80 ${
                  isActive ? "font-semibold text-text" : "text-text-tertiary"
                }`}
              >
                {product.label}
              </Link>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
