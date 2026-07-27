import { Settings } from "lucide-react";
import { Form, Link, useLocation } from "react-router";

import { PLATFORM_LINKS } from "~/lib/nav/manifest";
import { useDropdown } from "~/lib/nav/use-dropdown";

// Legacy's GEAR_ITEM_CLASS verbatim in effect: text-label resolves to
// 0.8125rem, legacy's own literal value. transition-opacity duration-150 is
// legacy's; without it the hover:opacity-80 snapped instead of easing.
const ITEM_CLASS =
  "block w-full cursor-pointer border-0 bg-transparent px-3 py-2 text-left text-label no-underline transition-opacity duration-150 hover:opacity-80";

// Consolidates Billing/Settings/Team/Help/Admin/Sign out into one utility
// icon (task Part 2: "Settings/Billing/Help/Sign out/Admin all live inside
// the gear dropdown so the chrome stays a single utility icon column").
// `accountLabel` (TASK-foxhound-app-shell-header-stability.md) also moved in
// here: the header row used to render it as a standalone truncating text
// node next to the utility cluster, which legacy never did (an avatar, not a
// name, sits there) and which grew the row's width with Recovery's longer
// link set. It renders as a non-interactive header line inside this
// already-existing menu instead of a new header element.
export function GearMenu({
  isAdmin,
  accountLabel,
  hasAccount,
}: {
  isAdmin: boolean;
  accountLabel: string;
  hasAccount: boolean;
}) {
  const location = useLocation();
  const { open, setOpen, ref } = useDropdown<HTMLDivElement>();

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Open menu"
        aria-expanded={open}
        className="flex cursor-pointer items-center justify-center rounded-md border-0 bg-transparent p-1.5 transition-colors duration-150 hover:bg-white/10"
      >
        <Settings width={16} height={16} strokeWidth={1.5} className="text-chrome-text-secondary" aria-hidden />
      </button>

      {open ? (
        <div className="absolute top-full right-0 z-50 mt-1 min-w-[160px] rounded-md border border-border bg-surface py-1 shadow-lg">
          <div className="truncate border-b border-border px-3 py-2 text-label text-text-tertiary" title={accountLabel}>
            {accountLabel}
          </div>
          {/* Legacy marks the current page with aria-current ONLY: every row
              keeps text-text-secondary, with no weight or color change. The
              bolded active row here was an addition legacy's dropdown never
              had, so the visual active affordance is dropped and the
              assistive-tech one kept. */}
          {PLATFORM_LINKS.filter((link) => !link.requiresAccount || hasAccount).map((link) => {
            const isActive = location.pathname === link.to || location.pathname.startsWith(`${link.to}/`);
            return (
              <Link
                key={link.to}
                to={link.to}
                onClick={() => setOpen(false)}
                aria-current={isActive ? "page" : undefined}
                className={`${ITEM_CLASS} text-text-secondary`}
              >
                {link.label}
              </Link>
            );
          })}
          {isAdmin ? (
            <>
              <div className="my-1 border-t border-border" />
              <Link to="/admin" onClick={() => setOpen(false)} className={`${ITEM_CLASS} text-red`}>
                Admin
              </Link>
            </>
          ) : null}
          <div className="my-1 border-t border-border" />
          <Form method="post" action="/logout">
            <button type="submit" className={`${ITEM_CLASS} text-text-secondary`}>
              Sign out
            </button>
          </Form>
        </div>
      ) : null}
    </div>
  );
}
