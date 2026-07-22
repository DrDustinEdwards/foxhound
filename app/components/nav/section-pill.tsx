import { ChevronDown } from "lucide-react";
import { Link } from "react-router";

import { PLATFORM_LINKS, PRODUCT_MANIFEST } from "~/lib/nav/manifest";
import { useDropdown } from "~/lib/nav/use-dropdown";

// The marketing header's authenticated-only counterpart to the app-shell's
// ProductSwitcher (TASK-foxhound-marketing-header-v2.md), next to the
// wordmark. Marketing pages track no active product (there is nothing to
// switch between while browsing marketing), so the label is always "Home";
// the dropdown is a fixed jump list into the app: Dashboard, Recovery,
// Disputes, Intelligence (gated by intelligenceEntitled, same as the
// app-shell switcher), then Billing and Settings from PLATFORM_LINKS. Every
// href here is manifest data already covered by test/nav-manifest.test.ts's
// drift check, so nothing new needs its own route-existence test.
const PLATFORM_PILL_LABELS = new Set(["Billing", "Settings"]);

export function SectionPill({ intelligenceEntitled }: { intelligenceEntitled: boolean }) {
  const { open, setOpen, ref } = useDropdown<HTMLDivElement>();

  const items: { label: string; to: string }[] = [
    { label: PRODUCT_MANIFEST.dashboard.label, to: PRODUCT_MANIFEST.dashboard.href },
    { label: PRODUCT_MANIFEST.recovery.label, to: PRODUCT_MANIFEST.recovery.href },
    { label: PRODUCT_MANIFEST.disputes.label, to: PRODUCT_MANIFEST.disputes.href },
    ...(intelligenceEntitled
      ? [{ label: PRODUCT_MANIFEST.intelligence.label, to: PRODUCT_MANIFEST.intelligence.href }]
      : []),
    ...PLATFORM_LINKS.filter((link) => PLATFORM_PILL_LABELS.has(link.label)),
  ];

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
              className="block px-3 py-2 text-label text-text-tertiary no-underline hover:opacity-80"
            >
              {item.label}
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  );
}
