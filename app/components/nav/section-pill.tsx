import { ChevronDown } from "lucide-react";
import { Link } from "react-router";

import { MARKETING_PILL_ITEMS } from "~/lib/nav/manifest";
import { useDropdown } from "~/lib/nav/use-dropdown";

// The marketing header's authenticated-only counterpart to the app-shell's
// ProductSwitcher (TASK-foxhound-marketing-header-v2.md), next to the
// wordmark. Marketing pages track no active product (there is nothing to
// switch between while browsing marketing), so the label is always "Home".
//
// Item set and order are legacy: Console, Audit, Recovery, Disputes,
// Intelligence (gated by intelligenceEntitled, same gate the app-shell
// switcher uses), no icons, no separators.
//
// Panel and row styling come from legacy SOURCE, not from the 2026-07-22
// screenshot that TASK-foxhound-pill-menu-parity.md read them off
// (ruling 50: source outranks screenshot). That earlier pass produced a
// roomier panel with larger text than legacy actually ships. Billing and
// Settings are dropped:
// Settings is already the gear icon's job, Billing lives in-app. See
// MARKETING_PILL_ITEMS (app/lib/nav/manifest.ts) for the item data and the
// Audit-route mapping decision; every href there is covered by
// test/marketing-nav.test.ts's drift check.
export function SectionPill({ intelligenceEntitled }: { intelligenceEntitled: boolean }) {
  const { open, setOpen, ref } = useDropdown<HTMLDivElement>();

  const items = MARKETING_PILL_ITEMS.filter(
    (item) => !item.requiresIntelligenceEntitlement || intelligenceEntitled,
  );

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 font-mono text-label font-medium text-chrome-text transition-colors duration-150 hover:border-chrome-text-secondary"
      >
        Home
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
          {items.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              onClick={() => setOpen(false)}
              className="block px-3 py-2 text-label text-text-tertiary no-underline transition-opacity duration-150 hover:opacity-80"
            >
              {item.label}
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  );
}
