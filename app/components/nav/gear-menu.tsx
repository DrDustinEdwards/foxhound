import { Settings } from "lucide-react";
import { Form, Link, useLocation } from "react-router";

import { PLATFORM_LINKS } from "~/lib/nav/manifest";
import { useDropdown } from "~/lib/nav/use-dropdown";

const ITEM_CLASS =
  "block w-full cursor-pointer border-0 bg-transparent px-3 py-2 text-left text-label no-underline hover:opacity-80";

// Consolidates Billing/Settings/Team/Help/Admin/Sign out into one utility
// icon (task Part 2: "Settings/Billing/Help/Sign out/Admin all live inside
// the gear dropdown so the chrome stays a single utility icon column").
export function GearMenu({ isAdmin }: { isAdmin: boolean }) {
  const location = useLocation();
  const { open, setOpen, ref } = useDropdown<HTMLDivElement>();

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Open menu"
        aria-expanded={open}
        className="flex h-8 w-8 items-center justify-center rounded-md text-chrome-text-secondary hover:bg-white/10 hover:text-chrome-text"
      >
        <Settings width={16} height={16} strokeWidth={1.5} aria-hidden />
      </button>

      {open ? (
        <div className="absolute top-full right-0 z-50 mt-1 min-w-[160px] rounded-md border border-border bg-surface py-1 shadow-lg">
          {PLATFORM_LINKS.map((link) => {
            const isActive = location.pathname === link.to || location.pathname.startsWith(`${link.to}/`);
            return (
              <Link
                key={link.to}
                to={link.to}
                onClick={() => setOpen(false)}
                aria-current={isActive ? "page" : undefined}
                className={`${ITEM_CLASS} ${isActive ? "font-semibold text-text" : "text-text-secondary"}`}
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
